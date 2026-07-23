# Repository secret policy

This package is a dependency-free Node 22 safety gate for ORA-006. It scans the
Git-visible repository surface, rejects credential-bearing filenames, detects
common provider credential shapes, and never emits matched content.

## Commands

Run the executable self-test. All seeded positive and negative fixtures are
created beneath the operating system's temporary directory and removed in a
validated cleanup block:

```powershell
& 'E:\nvm\v22.18.0\node.exe' tools/secret-policy/self-test.mjs
```

Scan the entire repository:

```powershell
& 'E:\nvm\v22.18.0\node.exe' tools/secret-policy/scan.mjs --repo . --format text
```

Exit codes are stable: `0` means clean, `1` means policy findings, and `2`
means the scan could not establish a complete trustworthy result. JSON output
is available with `--format json`.

Validate one explicit ignored ingress file without displaying values:

```powershell
& 'E:\nvm\v22.18.0\node.exe' tools/secret-policy/validate-ingress.mjs --repo . --file .env.local
```

## Safety properties

- Candidate files come from one NUL-delimited Git query containing tracked and
  unignored files. Ignored local credential material is not opened.
- Repository-root provider `*.env` files, `.config/`, `.aws/`, `token.json`, and
  `.npmrc` are ignored, while `.env.example`, source, fixtures, lock contracts,
  and assessment evidence remain visible.
- A prohibited path is reported without opening its contents. The self-test
  force-adds a prohibited path to a temporary Git index, deletes its worktree
  file, and proves the scanner still enumerates and rejects the cached path
  without a stat/read error.
- Symlinks, non-regular files, path escapes, repository-identity failures,
  enumeration failures, and read failures make the scan fail closed.
- Windows separators are normalized to repository-relative forward slashes
  before policy matching.
- Reports contain only sanitized repository paths, rule identifiers, and
  counts. They contain no line, column, snippet, match, or file content.
- A path that itself resembles a credential is replaced with a deterministic
  redacted path identifier.
- The ingress loader has no default file discovery. It accepts only an
  explicit regular file inside the verified repository that Git confirms is
  untracked and ignored. Tracked, unignored, symlinked, external, or `.config`
  paths are rejected before content is read.
- Static AWS keys and direct model-provider tokens are forbidden ingress
  variables. AWS uses an operator-managed profile locally and an independently
  approved identity mechanism for deployment automation.

The custom scanner complements `.gitleaks.toml`; it does not replace hosted
secret scanning or provider-side key rotation after a suspected disclosure.
The Gitleaks configuration is validated with the digest-pinned v8.30.1 image;
its Google presigned-signature branch uses a Go/RE2-compatible unbounded suffix
after the first 64 hexadecimal characters.
