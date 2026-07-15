import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cover } from "./manifest.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("AC-51 soofi-xyz ecosystem reuse", () => {
  it("ships kit-format agent, skill, and plugin manifests", () => {
    cover("AC-51");
    expect(existsSync(join(repoRoot, "agents/indeedee.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "skills/use-indeedee/SKILL.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "plugin.json"))).toBe(true);
    expect(existsSync(join(repoRoot, ".cursor-plugin/plugin.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "mcp.json"))).toBe(true);
  });
});

describe("AC-50 setup documentation", () => {
  it("documents env vars, deploy guide, and acceptance criteria", () => {
    cover("AC-50");
    expect(existsSync(join(repoRoot, ".env.example"))).toBe(true);
    expect(existsSync(join(repoRoot, "DEPLOY.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "ACCEPTANCE_CRITERIA.md"))).toBe(true);
    const envExample = readFileSync(join(repoRoot, ".env.example"), "utf8");
    expect(envExample).toMatch(/BEDROCK/);
    expect(envExample).toMatch(/ASANA/);
  });
});

describe("AC-01 simple setup (contract)", () => {
  it.skip("e2e: non-technical user connects channel via UI without CLI", () => {
    cover("AC-01");
  });
});
