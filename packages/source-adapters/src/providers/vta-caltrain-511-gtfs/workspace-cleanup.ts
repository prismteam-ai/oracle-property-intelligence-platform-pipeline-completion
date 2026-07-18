import { lstat, mkdtemp, opendir, realpath, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setImmediate as yieldToEventLoop, setTimeout as delay } from 'node:timers/promises';

const GTFS_WORKSPACE_PREFIX = 'oracle-gtfs-';
const MAXIMUM_GTFS_WORKSPACE_DEPTH = 8;
const MAXIMUM_MUTATION_RETRIES = 3;
const RETRY_DELAY_MILLISECONDS = 10;
const YIELD_AFTER_DELETIONS = 256;
const RETRYABLE_MUTATION_ERRORS = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface TrustedWorkspace {
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
  readonly root: string;
  readonly rootIdentity: FileIdentity;
}

interface CleanupState {
  deletedEntries: number;
  readonly root: string;
  readonly rootIdentity: FileIdentity;
  readonly options: GtfsWorkspaceCleanupOptions;
}

export interface GtfsWorkspace {
  readonly root: string;
}

export interface GtfsWorkspaceMutationAttempt {
  readonly attempt: number;
  readonly operation: 'remove-directory' | 'remove-entry';
  readonly path: string;
}

export interface GtfsWorkspaceCleanupOptions {
  /** Test/observability seam invoked immediately before each mutation attempt. */
  readonly beforeMutationAttempt?: (attempt: GtfsWorkspaceMutationAttempt) => void | Promise<void>;
}

const trustedWorkspaces = new WeakMap<GtfsWorkspace, TrustedWorkspace>();

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function identityOf(stats: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return Object.freeze({ device: BigInt(stats.dev), inode: BigInt(stats.ino) });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === '';
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

async function inspectExactDirectory(
  path: string,
  expectedIdentity: FileIdentity,
  root?: string,
): Promise<'missing' | 'present'> {
  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing to traverse a replaced or linked GTFS directory: ${path}`);
  }
  if (!sameIdentity(identityOf(stats), expectedIdentity)) {
    throw new Error(`Refusing to traverse a replaced GTFS directory: ${path}`);
  }
  const canonical = await realpath(path);
  if (!samePath(canonical, path) || (root !== undefined && !isWithinRoot(root, canonical))) {
    throw new Error(`Refusing to traverse a GTFS directory outside its trusted workspace: ${path}`);
  }
  return 'present';
}

async function mutateWithBoundedRetry(
  path: string,
  operation: GtfsWorkspaceMutationAttempt['operation'],
  mutation: () => Promise<void>,
  options: GtfsWorkspaceCleanupOptions,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await options.beforeMutationAttempt?.({ attempt, operation, path });
      await mutation();
      return;
    } catch (error) {
      if (
        attempt >= MAXIMUM_MUTATION_RETRIES ||
        !RETRYABLE_MUTATION_ERRORS.has(errorCode(error) ?? '')
      ) {
        throw error;
      }
      await yieldToEventLoop();
      await delay(RETRY_DELAY_MILLISECONDS * (attempt + 1));
    }
  }
}

async function removeEntry(path: string, state: CleanupState): Promise<void> {
  await mutateWithBoundedRetry(
    path,
    'remove-entry',
    async () => {
      await rm(path, { force: true });
    },
    state.options,
  );
}

async function removeEmptyDirectory(
  path: string,
  expectedIdentity: FileIdentity,
  state: CleanupState,
): Promise<void> {
  const presence = await inspectExactDirectory(path, expectedIdentity, state.root);
  if (presence === 'missing') return;
  await mutateWithBoundedRetry(
    path,
    'remove-directory',
    async () => {
      try {
        await rmdir(path);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    },
    state.options,
  );
}

async function removeDirectoryContentsBounded(
  directory: string,
  expectedIdentity: FileIdentity,
  depth: number,
  state: CleanupState,
): Promise<void> {
  if (depth > MAXIMUM_GTFS_WORKSPACE_DEPTH) {
    throw new Error('GTFS workspace exceeds its reviewed cleanup depth');
  }
  if ((await inspectExactDirectory(directory, expectedIdentity, state.root)) === 'missing') return;
  const entries = await opendir(directory);
  for await (const entry of entries) {
    // Node has no portable openat/unlinkat API. Rechecking the directory identity before each
    // path-based mutation narrows replacement races while keeping traversal streaming.
    if ((await inspectExactDirectory(directory, expectedIdentity, state.root)) === 'missing') {
      throw new Error(`GTFS workspace directory disappeared during cleanup: ${directory}`);
    }
    const child = join(directory, entry.name);
    if (!isWithinRoot(state.root, child)) {
      throw new Error(`Refusing to remove a GTFS entry outside its trusted workspace: ${child}`);
    }
    let childStats;
    try {
      // Always lstat instead of trusting Dirent: some filesystems report UV_DIRENT_UNKNOWN.
      childStats = await lstat(child, { bigint: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    if (childStats.isSymbolicLink()) {
      await removeEntry(child, state);
    } else if (childStats.isDirectory()) {
      const childIdentity = identityOf(childStats);
      if (childIdentity.device !== state.rootIdentity.device) {
        throw new Error(`Refusing to traverse a cross-filesystem GTFS directory: ${child}`);
      }
      const canonicalChild = await realpath(child);
      if (!samePath(canonicalChild, child) || !isWithinRoot(state.root, canonicalChild)) {
        // A directory reparse point that is not surfaced as a symbolic link must never be followed.
        await removeEntry(child, state);
      } else {
        await removeDirectoryContentsBounded(child, childIdentity, depth + 1, state);
        await removeEmptyDirectory(child, childIdentity, state);
      }
    } else {
      await removeEntry(child, state);
    }
    state.deletedEntries += 1;
    if (state.deletedEntries % YIELD_AFTER_DELETIONS === 0) await yieldToEventLoop();
  }
}

/** Creates the only capability accepted by the bounded GTFS cleanup routine. */
export async function createGtfsWorkspace(): Promise<GtfsWorkspace> {
  const parent = await realpath(tmpdir());
  const parentStats = await lstat(parent, { bigint: true });
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error('GTFS temporary parent is not a trusted directory');
  }
  const root = await mkdtemp(join(parent, GTFS_WORKSPACE_PREFIX));
  const rootStats = await lstat(root, { bigint: true });
  const canonicalRoot = await realpath(root);
  if (
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    !samePath(canonicalRoot, root) ||
    !samePath(dirname(root), parent) ||
    !basename(root).startsWith(GTFS_WORKSPACE_PREFIX)
  ) {
    throw new Error('Created GTFS workspace failed its trust checks');
  }
  const workspace = Object.freeze({ root });
  trustedWorkspaces.set(
    workspace,
    Object.freeze({
      parent,
      parentIdentity: identityOf(parentStats),
      root,
      rootIdentity: identityOf(rootStats),
    }),
  );
  return workspace;
}

/**
 * Removes only the exact workspace represented by a live createGtfsWorkspace capability.
 *
 * Traversal streams directory entries and performs sequential mutations, so it does not retain a
 * one-file-per-key corpus in memory. No claim about a specific corpus size or RSS is made here.
 */
export async function removeGtfsWorkspaceBounded(
  workspace: GtfsWorkspace,
  options: GtfsWorkspaceCleanupOptions = {},
): Promise<void> {
  const trusted = trustedWorkspaces.get(workspace);
  if (workspace.root !== trusted?.root) {
    throw new TypeError('Refusing to remove an untrusted GTFS workspace capability');
  }
  if ((await inspectExactDirectory(trusted.parent, trusted.parentIdentity)) === 'missing') {
    throw new Error('Trusted GTFS workspace parent disappeared');
  }
  const rootPresence = await inspectExactDirectory(
    trusted.root,
    trusted.rootIdentity,
    trusted.root,
  );
  if (rootPresence === 'missing') {
    trustedWorkspaces.delete(workspace);
    return;
  }
  const state: CleanupState = {
    deletedEntries: 0,
    options,
    root: trusted.root,
    rootIdentity: trusted.rootIdentity,
  };
  await removeDirectoryContentsBounded(trusted.root, trusted.rootIdentity, 0, state);
  await removeEmptyDirectory(trusted.root, trusted.rootIdentity, state);
  trustedWorkspaces.delete(workspace);
}
