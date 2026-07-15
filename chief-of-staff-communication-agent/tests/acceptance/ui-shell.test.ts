import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cover } from "./manifest.js";

const indexHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../apps/web/public/index.html"),
  "utf8",
);

describe("UI shell (AC-23–25 structure)", () => {
  it("includes dashboard tiles, channel bars, and recommended actions regions", () => {
    cover("AC-23");
    expect(indexHtml).toContain('id="panel-dashboard"');
    expect(indexHtml).toContain('id="tiles"');
    expect(indexHtml).toContain('id="bars"');
    expect(indexHtml).toContain('id="rec-list"');
    expect(indexHtml).toContain("renderDashboard");
  });

  it("includes incoming kanban with recommendation badges", () => {
    cover("AC-24");
    expect(indexHtml).toContain('id="panel-incoming"');
    expect(indexHtml).toContain('id="kanban"');
    expect(indexHtml).toContain("bucketOf");
    expect(indexHtml).toContain("openDetail");
  });

  it("includes approvals panel with approve and reject actions", () => {
    cover("AC-25");
    expect(indexHtml).toContain('id="panel-approvals"');
    expect(indexHtml).toContain("approveDraft");
    expect(indexHtml).toContain("rejectDraft");
    expect(indexHtml).toContain('class="approve"');
  });

  it("includes people split-pane thread view", () => {
    expect(indexHtml).toContain('id="panel-people"');
    expect(indexHtml).toContain('id="people-list"');
    expect(indexHtml).toContain('id="people-thread"');
    expect(indexHtml).toContain("selectPerson");
  });

  it("includes login overlay for Google SSO", () => {
    expect(indexHtml).toContain('id="login-overlay"');
    expect(indexHtml).toContain("signInWithGoogle");
    expect(indexHtml).toContain("/api/auth/config");
  });
});
