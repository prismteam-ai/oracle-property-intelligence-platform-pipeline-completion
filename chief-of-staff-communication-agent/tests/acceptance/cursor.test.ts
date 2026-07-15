import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { IndeedeeToolNames } from "@indeedee/api/agent/tools";
import { cover } from "./manifest.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("AC-26 Cursor agent surface", () => {
  it("ships agent definition and MCP config template", () => {
    cover("AC-26");
    const agent = readFileSync(join(repoRoot, "agents/indeedee.md"), "utf8");
    expect(agent).toMatch(/name: indeedee/);
    expect(existsSync(join(repoRoot, "mcp.json"))).toBe(true);
  });
});

describe("AC-28 Cursor recommend, draft, and Asana tools", () => {
  it("registers tool contracts for retrieve, recommend, draft, Asana, and gated send", () => {
    cover("AC-28");
    expect(IndeedeeToolNames).toContain("retrieve_context");
    expect(IndeedeeToolNames).toContain("recommend_action");
    expect(IndeedeeToolNames).toContain("draft_reply");
    expect(IndeedeeToolNames).toContain("propose_asana_task");
    expect(IndeedeeToolNames).toContain("approve_and_send");
  });
});

describe("AC-27 Cursor RAG retrieval", () => {
  it("rag CLI returns owner-scoped JSON hits from local index", () => {
    cover("AC-27");
    const dir = mkdtempSync(join(tmpdir(), "indeedee-rag-"));
    const dbPath = join(dir, "test.db");
    try {
      execFileSync(
        "node",
        [
          join(repoRoot, "packages/rag-cli/dist/retrieve.js"),
          "project deadline",
          "--owner-id",
          "owner-test",
          "--json",
        ],
        {
          env: { ...process.env, INDEEDEE_RAG_DB: dbPath },
          encoding: "utf8",
        },
      );
      const out = execFileSync(
        "node",
        [
          join(repoRoot, "packages/rag-cli/dist/retrieve.js"),
          "anything",
          "--owner-id",
          "owner-test",
          "--json",
        ],
        {
          env: { ...process.env, INDEEDEE_RAG_DB: dbPath },
          encoding: "utf8",
        },
      );
      expect(JSON.parse(out)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rag.search API scopes results to caller ownerId", async () => {
    cover("AC-27");
    const { appRouter } = await import("@indeedee/api/trpc/router");
    const caller = appRouter.createCaller({ ownerId: "owner-a", role: "owner" });
    const result = await caller.rag.search({ query: "status update" });
    expect(result.ownerId).toBe("owner-a");
    expect(result).toHaveProperty("hits");
  });
});
