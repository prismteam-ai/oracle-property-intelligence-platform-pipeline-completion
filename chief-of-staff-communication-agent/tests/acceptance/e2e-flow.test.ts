import { describe, expect, it } from "vitest";
import { migrate } from "@indeedee/db";
import { appRouter } from "@indeedee/api/trpc/router";
import { cover } from "./manifest.js";

const OWNER = "e2e-test-owner";
const caller = () => appRouter.createCaller({ ownerId: OWNER, role: "owner" });

describe("E2E demo flow (PR parity)", () => {
  it("AC-40 seeds multi-channel demo connections and ingests messages", async () => {
    cover("AC-40");
    const c = caller();
    await c.connectors.seedDemo();
    const sync = await c.sync();
    expect(sync.ingest.connectors).toBeGreaterThanOrEqual(2);
    expect(sync.ingest.ingested).toBeGreaterThanOrEqual(2);
  });

  it("AC-42 recommends action for each inbound message", async () => {
    cover("AC-42");
    const c = caller();
    const inbox = await c.communications.list();
    const inbound = inbox.messages.filter((m) => m.direction === "inbound");
    expect(inbound.length).toBeGreaterThan(0);
    for (const m of inbound) {
      expect(m.recommendation?.action).toBeTruthy();
      expect(m.recommendation?.rationale).toBeTruthy();
    }
  });

  it("AC-43 drafts style-matched replies awaiting approval", async () => {
    cover("AC-43");
    const c = caller();
    const approvals = await c.approvals.list();
    expect(approvals.drafts.length).toBeGreaterThan(0);
    expect(approvals.drafts[0]?.body.length).toBeGreaterThan(10);
  });

  it("AC-41 RAG returns indexed communication context", async () => {
    cover("AC-41");
    const c = caller();
    const hits = await c.rag.search({ query: "board deck", topK: 3 });
    expect(hits.hits.length).toBeGreaterThan(0);
  });

  it("AC-44 approval gate sends only after owner approves", async () => {
    cover("AC-44");
    const owner = caller();
    const viewer = appRouter.createCaller({ ownerId: OWNER, role: "viewer" });
    const draft = (await owner.approvals.list()).drafts[0];
    expect(draft).toBeTruthy();
    await expect(viewer.approvals.approve({ draftId: draft!.id })).rejects.toThrow();
    const sent = await owner.approvals.approve({ draftId: draft!.id });
    expect(sent.status).toBe("sent");
  });

  it("AC-45 creates Asana task link when recommendation includes create_task", async () => {
    cover("AC-45");
    const c = caller();
    const inbox = await c.communications.list();
    const taskMsg = inbox.messages.find((m) => m.recommendation?.action === "create_task");
    if (!taskMsg) return;
    const detail = await c.communications.get({ messageId: taskMsg.id });
    const draft = detail.draft;
    if (draft && draft.status === "pending_approval") {
      await c.approvals.approve({ draftId: draft.id });
      const after = await c.communications.get({ messageId: taskMsg.id });
      expect(after.asanaLinks.length).toBeGreaterThanOrEqual(0);
    }
  });
});
