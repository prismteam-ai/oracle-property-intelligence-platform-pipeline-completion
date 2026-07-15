---
name: use-indeedee
description: "Operate the Indeedee Chief of Staff Communication Agent from Cursor: retrieve communication and Asana context via the local RAG CLI, then recommend actions, draft replies, and propose Asana updates — never auto-send. Triggers on: indeedee, chief of staff, executive inbox, communication draft, approve send, pending messages."
---

# Use Indeedee from Cursor

Indeedee is the Chief of Staff Communication Agent. This skill governs Cursor-side operation:
retrieve context first, then recommend or draft. **Sending always requires explicit human approval**
in the web UI or via the `approve_and_send` tool after the user confirms.

## Prerequisites

- This repo is the workspace (`indeedee-agent` monorepo).
- Copy `.env.example` to `.env` and fill Bedrock / Asana credentials when running the full agent.
- Build packages: `pnpm install && pnpm build`.

## Retrieve context (read-only)

Run from repo root after `pnpm --filter @indeedee/rag-cli build`:

```bash
node packages/rag-cli/dist/retrieve.js "<query>" [--owner-id ID] [--top-k N] [--json]
```

Derive 1–3 focused queries from the user's ask (person name, project, thread topic).
Use `--json` when you need structured hits for tool chaining.

If the database is empty, run sync/ingest in the API first or add knowledge via the UI.

## Agent tools (when MCP is configured)

MCP tools mirror the ash ToolLoopAgent surface:

| Tool | Purpose |
|------|---------|
| `retrieve_context` | RAG search over comms + Asana + preferences |
| `list_pending` | Unanswered inbound messages |
| `recommend_action` | Next action for one message |
| `draft_reply` | Style-matched draft (pending approval) |
| `propose_asana_task` | Create/link Asana work (pending approval) |
| `approve_and_send` | Send only after user explicitly approves |
| `dashboard_stats` | Volume, overdue, SLA metrics |

Configure MCP in `.cursor/mcp.json` (see repo root `mcp.json` template).

## Rules

- Retrieve before recommend or draft.
- Never call `approve_and_send` unless the user explicitly asked to send an approved draft.
- Route low-confidence cases to `needs_context` — ask the user rather than inventing facts.
- Per-user tokens scope all data; do not assume cross-tenant visibility.
