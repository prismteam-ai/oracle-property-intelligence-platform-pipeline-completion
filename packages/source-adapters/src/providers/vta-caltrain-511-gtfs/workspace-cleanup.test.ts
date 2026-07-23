import { mkdir, mkdtemp, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createGtfsWorkspace,
  removeGtfsWorkspaceBounded,
  type GtfsWorkspace,
} from './workspace-cleanup.js';

function systemError(code: string): Error & { code: string } {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

function linkUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP')
  );
}

async function createDirectoryLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (linkUnavailable(error)) return false;
    throw error;
  }
}

async function removeTestPath(path: string): Promise<void> {
  await rm(path, { force: true, maxRetries: 3, recursive: true, retryDelay: 10 });
}

describe('bounded GTFS workspace cleanup', () => {
  it('streams a small nested marker corpus and removes the trusted root', async () => {
    const workspace = await createGtfsWorkspace();
    try {
      for (let shard = 0; shard < 4; shard += 1) {
        const directory = join(
          workspace.root,
          'keys',
          'stop_times.txt',
          shard.toString(16).padStart(2, '0'),
        );
        await mkdir(directory, { recursive: true });
        for (let item = 0; item < 32; item += 1) {
          await writeFile(
            join(directory, `${item.toString(16).padStart(4, '0')}.key`),
            `${item}\n`,
          );
        }
      }

      await removeGtfsWorkspaceBounded(workspace);
      await expect(stat(workspace.root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTestPath(workspace.root);
    }
  });

  it('rejects arbitrary roots even when their names use the GTFS prefix', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'oracle-gtfs-arbitrary-'));
    const outsideFile = join(outside, 'must-remain.txt');
    await writeFile(outsideFile, 'retained\n');
    try {
      await expect(
        removeGtfsWorkspaceBounded(Object.freeze({ root: outside }) as GtfsWorkspace),
      ).rejects.toThrow('untrusted GTFS workspace capability');
      await expect(stat(outsideFile)).resolves.toBeDefined();
    } finally {
      await removeTestPath(outside);
    }
  });

  it('accepts an already-missing root only for its live trusted capability', async () => {
    const workspace = await createGtfsWorkspace();
    await rmdir(workspace.root);

    await expect(removeGtfsWorkspaceBounded(workspace)).resolves.toBeUndefined();
    await expect(removeGtfsWorkspaceBounded(workspace)).rejects.toThrow(
      'untrusted GTFS workspace capability',
    );
  });

  it('fails closed when the reviewed directory depth is exceeded', async () => {
    const workspace = await createGtfsWorkspace();
    let directory = workspace.root;
    try {
      for (let depth = 0; depth < 9; depth += 1) {
        directory = join(directory, `level-${depth}`);
        await mkdir(directory);
      }
      await writeFile(join(directory, 'marker.key'), 'retained\n');

      await expect(removeGtfsWorkspaceBounded(workspace)).rejects.toThrow(
        'exceeds its reviewed cleanup depth',
      );
      await expect(stat(workspace.root)).resolves.toBeDefined();
    } finally {
      await removeTestPath(workspace.root);
      await removeGtfsWorkspaceBounded(workspace).catch(() => undefined);
    }
  });

  it('removes a child directory link without following it when links are available', async ({
    skip,
  }) => {
    const workspace = await createGtfsWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'gtfs-cleanup-link-target-'));
    const outsideFile = join(outside, 'must-remain.txt');
    const childLink = join(workspace.root, 'linked-directory');
    await writeFile(outsideFile, 'retained\n');
    try {
      if (!(await createDirectoryLink(outside, childLink))) {
        skip();
        return;
      }

      await removeGtfsWorkspaceBounded(workspace);
      await expect(stat(outsideFile)).resolves.toBeDefined();
      await expect(stat(workspace.root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTestPath(workspace.root);
      await removeTestPath(outside);
    }
  });

  it('rejects a root replaced by a different ordinary directory', async () => {
    const workspace = await createGtfsWorkspace();
    const displacedRoot = `${workspace.root}-displaced`;
    let displaced = false;
    try {
      await rename(workspace.root, displacedRoot);
      displaced = true;
      await mkdir(workspace.root);

      await expect(removeGtfsWorkspaceBounded(workspace)).rejects.toThrow(
        'replaced GTFS directory',
      );

      await rmdir(workspace.root);
      await rename(displacedRoot, workspace.root);
      displaced = false;
      await removeGtfsWorkspaceBounded(workspace);
    } finally {
      if (displaced) await removeTestPath(displacedRoot);
      await removeTestPath(workspace.root);
    }
  });

  it('rejects a root replaced by a directory link without touching its target', async ({
    skip,
  }) => {
    const workspace = await createGtfsWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'gtfs-cleanup-root-link-target-'));
    const outsideFile = join(outside, 'must-remain.txt');
    const displacedRoot = `${workspace.root}-displaced`;
    let displaced = false;
    let linked = false;
    await writeFile(outsideFile, 'retained\n');
    try {
      await rename(workspace.root, displacedRoot);
      displaced = true;
      linked = await createDirectoryLink(outside, workspace.root);
      if (!linked) {
        await rename(displacedRoot, workspace.root);
        displaced = false;
        await removeGtfsWorkspaceBounded(workspace);
        skip();
        return;
      }

      await expect(removeGtfsWorkspaceBounded(workspace)).rejects.toThrow(
        'replaced or linked GTFS directory',
      );
      await expect(stat(outsideFile)).resolves.toBeDefined();

      await rm(workspace.root, { force: true });
      linked = false;
      await rename(displacedRoot, workspace.root);
      displaced = false;
      await removeGtfsWorkspaceBounded(workspace);
    } finally {
      if (linked) await rm(workspace.root, { force: true });
      if (displaced) await removeTestPath(displacedRoot);
      await removeTestPath(workspace.root);
      await removeTestPath(outside);
    }
  });

  it.each(['EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY'])(
    'retries transient %s mutation failures after yielding to the event loop',
    async (code) => {
      const workspace = await createGtfsWorkspace();
      const marker = join(workspace.root, 'marker.key');
      const attempts: number[] = [];
      let yielded = false;
      await writeFile(marker, 'delete me\n');
      try {
        await removeGtfsWorkspaceBounded(workspace, {
          beforeMutationAttempt: ({ attempt, operation, path }) => {
            if (operation !== 'remove-entry' || path !== marker) return;
            attempts.push(attempt);
            if (attempt === 0) {
              setImmediate(() => {
                yielded = true;
              });
              throw systemError(code);
            }
            expect(yielded).toBe(true);
          },
        });
        expect(attempts).toEqual([0, 1]);
      } finally {
        await removeTestPath(workspace.root);
      }
    },
  );

  it('bounds persistent retryable failures and permits a later cleanup retry', async () => {
    const workspace = await createGtfsWorkspace();
    const marker = join(workspace.root, 'marker.key');
    let attempts = 0;
    await writeFile(marker, 'delete me\n');
    try {
      await expect(
        removeGtfsWorkspaceBounded(workspace, {
          beforeMutationAttempt: ({ operation, path }) => {
            if (operation === 'remove-entry' && path === marker) {
              attempts += 1;
              throw systemError('EBUSY');
            }
          },
        }),
      ).rejects.toMatchObject({ code: 'EBUSY' });
      expect(attempts).toBe(4);

      await expect(removeGtfsWorkspaceBounded(workspace)).resolves.toBeUndefined();
    } finally {
      await removeTestPath(workspace.root);
    }
  });
});
