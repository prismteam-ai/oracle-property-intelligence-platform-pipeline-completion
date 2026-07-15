import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_ACCEPTANCE_CRITERIA } from "./manifest.js";

const acceptanceDir = dirname(fileURLToPath(import.meta.url));

describe("acceptance criteria coverage", () => {
  it("every AC id has at least one cover() registration in acceptance tests", () => {
    const files = readdirSync(acceptanceDir).filter(
      (f) => f.endsWith(".test.ts") && f !== "coverage.test.ts",
    );
    const source = files
      .map((f) => readFileSync(join(acceptanceDir, f), "utf8"))
      .join("\n");

    const missing = ALL_ACCEPTANCE_CRITERIA.filter(
      (id) => !source.includes(`cover("${id}")`),
    );

    expect(
      missing,
      `Missing cover("${missing[0]}") in acceptance tests`,
    ).toEqual([]);
    expect(ALL_ACCEPTANCE_CRITERIA.length).toBe(39);
  });
});
