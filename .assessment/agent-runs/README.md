# Native Team Kit run evidence

This directory stores redacted, task-bound evidence for native Team Kit runs.
A final message alone is not proof that a named agent ran.

Every material writer receipt must bind:

- one task or explicitly bounded task wave;
- repository root, branch, base HEAD, and writable descendants;
- exact `gpt-5.6-sol` / `ultra` parent and child turn contexts;
- selected bounded roster and active-config hash;
- rendered prompt and output hashes;
- parent thread ID and persistent rollout hash;
- child thread ID, `agent_path=/root/<name>`, parent linkage, and rollout hash;
- observed native wait;
- test/scan output hashes;
- an explicit list of denied external effects.

Receipts contain no credential value, provider payload, private data, or hidden
reasoning. A fallback model, missing child rollout, process reuse, unbound
write, or external effect invalidates the run.
