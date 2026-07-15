/** All acceptance criteria IDs from ACCEPTANCE_CRITERIA.md */
export const ALL_ACCEPTANCE_CRITERIA = [
  "AC-01",
  "AC-02",
  "AC-03",
  "AC-04",
  "AC-05",
  "AC-06",
  "AC-07",
  "AC-08",
  "AC-09",
  "AC-10",
  "AC-11",
  "AC-12",
  "AC-13",
  "AC-14",
  "AC-15",
  "AC-16",
  "AC-17",
  "AC-18",
  "AC-19",
  "AC-20",
  "AC-21",
  "AC-22",
  "AC-23",
  "AC-24",
  "AC-25",
  "AC-26",
  "AC-27",
  "AC-28",
  "AC-29",
  "AC-30",
  "AC-32",
  "AC-40",
  "AC-41",
  "AC-42",
  "AC-43",
  "AC-44",
  "AC-45",
  "AC-50",
  "AC-51",
] as const;

export type AcceptanceCriterionId = (typeof ALL_ACCEPTANCE_CRITERIA)[number];

export type AcceptanceTier = "structural" | "integration" | "e2e" | "manual";

export interface AcceptanceCriterionMeta {
  id: AcceptanceCriterionId;
  group: string;
  summary: string;
  tier: AcceptanceTier;
}

export const ACCEPTANCE_CRITERIA_META: AcceptanceCriterionMeta[] = [
  { id: "AC-01", group: "setup", summary: "Simple setup for non-technical users", tier: "e2e" },
  { id: "AC-02", group: "channels", summary: "Email across brands and accounts", tier: "e2e" },
  { id: "AC-03", group: "channels", summary: "Gmail provider", tier: "integration" },
  { id: "AC-04", group: "channels", summary: "Additional email providers", tier: "integration" },
  { id: "AC-05", group: "channels", summary: "SMS integration", tier: "integration" },
  { id: "AC-06", group: "channels", summary: "WhatsApp integration", tier: "integration" },
  { id: "AC-07", group: "channels", summary: "X integration", tier: "integration" },
  { id: "AC-08", group: "channels", summary: "LinkedIn integration", tier: "structural" },
  { id: "AC-09", group: "channels", summary: "Modular connector architecture", tier: "structural" },
  { id: "AC-10", group: "ingestion", summary: "Ingest messages, threads, metadata", tier: "structural" },
  { id: "AC-11", group: "ingestion", summary: "Centralized knowledge layer", tier: "structural" },
  { id: "AC-12", group: "ingestion", summary: "RAG over comms, Asana, prefs, org", tier: "integration" },
  { id: "AC-13", group: "ingestion", summary: "Preserve conversation history", tier: "structural" },
  { id: "AC-14", group: "ingestion", summary: "Cross-channel message linking", tier: "integration" },
  { id: "AC-15", group: "ai", summary: "Learn and apply response style", tier: "integration" },
  { id: "AC-16", group: "ai", summary: "Recommend action per message", tier: "structural" },
  { id: "AC-17", group: "ai", summary: "Style-matched draft replies", tier: "integration" },
  { id: "AC-32", group: "ai", summary: "Prompt for context when uncertain", tier: "structural" },
  { id: "AC-18", group: "asana", summary: "Link comms to Asana work", tier: "integration" },
  { id: "AC-19", group: "asana", summary: "Create/update Asana tasks", tier: "e2e" },
  { id: "AC-20", group: "approval", summary: "Approval before send", tier: "structural" },
  { id: "AC-21", group: "approval", summary: "Track answered status", tier: "structural" },
  { id: "AC-22", group: "approval", summary: "Under-five-minute SLA", tier: "structural" },
  { id: "AC-23", group: "ui", summary: "Dashboard metrics UI", tier: "integration" },
  { id: "AC-24", group: "ui", summary: "Recommended actions view", tier: "integration" },
  { id: "AC-25", group: "ui", summary: "Drafts awaiting approval view", tier: "integration" },
  { id: "AC-26", group: "cursor", summary: "Cursor agent", tier: "structural" },
  { id: "AC-27", group: "cursor", summary: "Cursor RAG retrieval", tier: "integration" },
  { id: "AC-28", group: "cursor", summary: "Cursor recommend/draft/Asana", tier: "structural" },
  { id: "AC-29", group: "security", summary: "Secure token management", tier: "integration" },
  { id: "AC-30", group: "security", summary: "User permission boundaries", tier: "structural" },
  { id: "AC-40", group: "demo", summary: "E2E multi-channel ingestion", tier: "e2e" },
  { id: "AC-41", group: "demo", summary: "E2E RAG retrieval demo", tier: "e2e" },
  { id: "AC-42", group: "demo", summary: "E2E recommendations demo", tier: "e2e" },
  { id: "AC-43", group: "demo", summary: "E2E style-matched drafts demo", tier: "e2e" },
  { id: "AC-44", group: "demo", summary: "E2E approval before send demo", tier: "e2e" },
  { id: "AC-45", group: "demo", summary: "E2E Asana task demo", tier: "e2e" },
  { id: "AC-50", group: "setup", summary: "Setup documentation", tier: "structural" },
  { id: "AC-51", group: "setup", summary: "soofi-xyz ecosystem reuse", tier: "structural" },
];

/** Populated by acceptance test files — one entry per AC id exercised. */
export const coveredAcceptanceCriteria = new Set<AcceptanceCriterionId>();

export function cover(id: AcceptanceCriterionId): AcceptanceCriterionId {
  coveredAcceptanceCriteria.add(id);
  return id;
}
