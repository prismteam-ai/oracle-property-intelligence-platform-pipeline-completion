# Chief of Staff Communication Agent — Acceptance Criteria

Derived from [README.md](./README.md). Each item is verifiable at demo or review time.

**Status key:** `[ ]` not started · `[~]` in progress · `[x]` done

---

## 1. Setup & onboarding

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-01 | Support setup that is simple enough for non-technical users. | A new user can connect at least one channel and view the inbox without CLI steps or editing config files. |
| AC-50 | Document setup instructions for the Chief of Staff Communication Agent. | README or SETUP guide covers prerequisites, env vars, deploy, and first-run connect flow. |
| AC-51 | Confirm the solution is reusable within the existing soofi-xyz agent ecosystem. | Ships kit-format agent (`agents/`), skill (`skills/`), plugin manifest, and maps to kit skills (ash, chatot, espeon, metagross). |

---

## 2. Channel integrations

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-02 | Support email integrations across all required brands and accounts. | Multiple email accounts/brands can be connected per user; messages appear tagged by account. |
| AC-03 | Support Gmail as one email provider. | Gmail OAuth connect, ingest, and send-after-approval work end-to-end. |
| AC-04 | Support additional email providers beyond Gmail. | At least one non-Gmail email provider (e.g. IMAP/Outlook) connects, ingests, and sends. |
| AC-05 | Support SMS integration. | SMS channel connects; inbound messages ingest; approved replies send. |
| AC-06 | Support WhatsApp integration. | WhatsApp channel connects; inbound messages ingest; approved replies send. |
| AC-07 | Support X integration. | X channel connects; inbound messages ingest; approved replies send. |
| AC-08 | Support LinkedIn integration. | LinkedIn channel connects or is explicitly documented as unavailable with a compliant alternative — not faked. |
| AC-09 | Support future communication channels through a modular connector architecture. | New channel = new connector module implementing the shared protocol; no changes to brain/RAG/UI core. |

---

## 3. Ingestion & knowledge layer

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-10 | Ingest messages, threads, metadata, participants, timestamps, and attachments where available. | Stored records include all fields the provider exposes; demo shows thread grouping and participants. |
| AC-11 | Consolidate all communication data into a centralized knowledge layer. | All channels write to one normalized store with provenance (`source`, `rawRef`, `fetchedAt`). |
| AC-12 | Build a RAG layer using communication history, Asana context, user preferences, and organizational knowledge. | Retrieval returns hits from each source type; brain/UI can query the same index. |
| AC-13 | Preserve conversation history across connected platforms. | Thread history survives sync cycles; outbound messages retained for style learning. |
| AC-14 | Link related messages across channels when they belong to the same topic, person, customer, project, or decision. | UI or API shows cross-channel links for the same person/topic; linkage is explainable. |

---

## 4. AI behavior — recommend, draft, style

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-15 | Learn and apply each user's response style. | Drafts reflect the user's past outbound messages and/or configured style preferences. |
| AC-16 | Recommend an action for every incoming communication. | Each inbound message has a recommendation record (action + rationale). |
| AC-17 | Draft suggested replies using relevant context and the user's communication style. | Draft cites retrieved context; tone matches configured/learned style. |
| AC-32 | Prompt the user for additional context when the agent cannot confidently respond. | Low-confidence messages route to `needs_context` with a specific question — no fabricated reply. |

---

## 5. Asana integration

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-18 | Connect communications clearly to relevant Asana tasks, projects, milestones, and comments. | Message detail shows linked Asana work with URLs/GIDs. |
| AC-19 | Create or update Asana tasks when a communication requires follow-up. | Demo: inbound message → proposed/created task with title, notes, due date; visible in Asana. |

---

## 6. Approval, send & SLA

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-20 | Prompt the user for final approval before sending a drafted response. | No send path bypasses approval; attempt without approval fails (app + tests). |
| AC-21 | Track whether each communication has been answered. | Each message has `answered` / `pending` state and timestamp when answered. |
| AC-22 | Support the goal of answering every communication in less than five minutes. | Dashboard shows overdue count (>5 min); sync/processing prioritizes newest inbound. |

---

## 7. UI

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-23 | Provide a UI showing communication volume, response status, overdue messages, pending approvals, channel breakdown, and response-time metrics. | Dashboard renders all listed metrics from live data. |
| AC-24 | Provide a UI view for recommended actions by communication. | Inbox/board shows recommendation per message. |
| AC-25 | Provide a UI view for drafted responses awaiting approval. | Approvals queue lists drafts with approve / edit / reject actions. |

---

## 8. Cursor agent & MCP

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-26 | Provide an agent that can be used directly in Cursor. | Plugin/agent manifest + MCP or skill documented and functional. |
| AC-27 | Allow the Cursor agent to retrieve communication context through the RAG layer. | MCP tool or CLI returns owner-scoped RAG hits for a query. |
| AC-28 | Allow the Cursor agent to recommend actions, draft responses, and update Asana. | MCP tools perform each action; send still requires explicit user approval. |

---

## 9. Security & multi-tenancy

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-29 | Securely authenticate and manage tokens for all connected services. | OAuth/PAT stored encrypted or in Secrets Manager; never logged or committed. |
| AC-30 | Enforce user-specific permission boundaries across connected accounts. | User A cannot read User B's messages, drafts, tokens, or RAG results. |

---

## 10. Demo requirements

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-40 | Demonstrate end-to-end ingestion from multiple channels. | Live demo: ≥2 channels ingest into unified inbox. |
| AC-41 | Demonstrate RAG-backed retrieval across communication and Asana context. | Query returns relevant comm + Asana hits with source labels. |
| AC-42 | Demonstrate recommended actions for incoming communications. | Show recommendation on a live inbound message. |
| AC-43 | Demonstrate style-matched draft replies. | Show draft that reflects user style + retrieved context. |
| AC-44 | Demonstrate user approval before response delivery. | Approve in UI → message sends; reject leaves unsent. |
| AC-45 | Demonstrate Asana task creation or update from a communication. | Live Asana task created/updated from a message flow. |

---

## Summary checklist

```
Setup & ecosystem     AC-01, AC-50, AC-51
Channels              AC-02 – AC-09
Ingestion & RAG       AC-10 – AC-14
AI behavior           AC-15 – AC-17, AC-32
Asana                 AC-18 – AC-19
Approval & SLA        AC-20 – AC-22
UI                    AC-23 – AC-25
Cursor / MCP          AC-26 – AC-28
Security              AC-29 – AC-30
Demo                  AC-40 – AC-45
```

**Total: 39 acceptance criteria**

---

## Automated tests

Run from repo root:

```bash
pnpm build && pnpm test
```

Tests live in `tests/acceptance/` — one `cover("AC-XX")` registration per criterion:

| Status | Meaning |
|--------|---------|
| **Passing** | Structural/contract check implemented today |
| **Skipped** | Integration, e2e, or manual — enabled as features land |

`tests/acceptance/coverage.test.ts` fails if any AC id lacks a registered test.
