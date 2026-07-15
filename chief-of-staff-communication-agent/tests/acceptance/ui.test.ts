import { describe, expect, it } from "vitest";
import { appRouter } from "@indeedee/api/trpc/router";
import { DashboardMetricsSchema } from "@indeedee/shared";
import { cover } from "./manifest.js";

const OWNER = "ui-integration-owner";
const owner = () => appRouter.createCaller({ ownerId: OWNER, role: "owner" });
const viewer = () => appRouter.createCaller({ ownerId: OWNER, role: "viewer" });

async function seedAndSync() {
  const c = owner();
  await c.connectors.seedDemo();
  await c.sync();
}

describe("AC-23 dashboard metrics API", () => {
  it("exposes volume, status, overdue, approvals, and channel breakdown fields", async () => {
    cover("AC-23");
    const caller = appRouter.createCaller({ ownerId: "o1", role: "owner" });
    const metrics = await caller.metrics.dashboard();
    const parsed = DashboardMetricsSchema.parse(metrics);
    expect(parsed).toMatchObject({
      totalInbound: expect.any(Number),
      answered: expect.any(Number),
      pending: expect.any(Number),
      overdue: expect.any(Number),
      pendingApprovals: expect.any(Number),
      byChannel: expect.any(Object),
    });
  });

  it("integration: dashboard payload matches UI loadAll contract after sync", async () => {
    cover("AC-23");
    await seedAndSync();
    const dash = await owner().metrics.dashboard();
    expect(dash.totalInbound).toBeGreaterThan(0);
    expect(Object.keys(dash.byChannel).length).toBeGreaterThan(0);
    expect(dash.pendingApprovals).toBeGreaterThan(0);
  });
});

describe("AC-24 recommended actions view", () => {
  it("communications.get returns recommendation slot scoped to owner", async () => {
    cover("AC-24");
    const caller = appRouter.createCaller({ ownerId: "o1", role: "viewer" });
    const list = await caller.communications.list();
    expect(list.ownerId).toBe("o1");
    if (list.messages[0]) {
      const detail = await caller.communications.get({ messageId: list.messages[0].id });
      expect(detail.ownerId).toBe("o1");
      expect(detail).toHaveProperty("recommendation");
    }
  });

  it("integration: inbox list enriches each message with recommendation for UI kanban", async () => {
    cover("AC-24");
    await seedAndSync();
    const inbox = await viewer().communications.list();
    const inbound = inbox.messages.filter((m) => m.direction === "inbound");
    expect(inbound.length).toBeGreaterThan(0);
    for (const m of inbound) {
      expect(m.recommendation?.action).toBeTruthy();
      expect(m.recommendation?.rationale).toBeTruthy();
    }
  });
});

describe("AC-25 drafts awaiting approval view", () => {
  it("approvals.list exposes owner-scoped draft queue", async () => {
    cover("AC-25");
    const caller = appRouter.createCaller({ ownerId: "o1", role: "owner" });
    const queue = await caller.approvals.list();
    expect(queue.ownerId).toBe("o1");
    expect(queue).toHaveProperty("drafts");
  });

  it("integration: approvals UI flow supports approve, edit body, and reject", async () => {
    cover("AC-25");
    await seedAndSync();
    const o = owner();
    const drafts = (await o.approvals.list()).drafts;
    expect(drafts.length).toBeGreaterThan(0);
    const draft = drafts[0]!;
    const edited = draft.body + "\n\n— edited in test";
    await expect(viewer().approvals.approve({ draftId: draft.id })).rejects.toThrow();

    const rejectTarget = drafts.find((d) => d.id !== draft.id) ?? draft;
    await o.approvals.reject({ draftId: rejectTarget.id });
    const afterReject = await o.approvals.list();
    expect(afterReject.drafts.every((d) => d.id !== rejectTarget.id)).toBe(true);

    const sent = await o.approvals.approve({ draftId: draft.id, editedBody: edited });
    expect(sent.status).toBe("sent");
  });
});

describe("People API (thread split-pane data)", () => {
  it("lists contacts and returns per-sender thread", async () => {
    await seedAndSync();
    const people = await owner().people.list();
    expect(people.people.length).toBeGreaterThan(0);
    const handle = people.people[0]!.handle;
    const thread = await owner().people.thread({ handle });
    expect(thread.messages.length).toBeGreaterThan(0);
    expect(thread.messages[0]?.recommendation).toBeTruthy();
  });
});
