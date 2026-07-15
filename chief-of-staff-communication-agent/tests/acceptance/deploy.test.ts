import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cover } from "./manifest.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const infraDir = join(repoRoot, "infra");

describe("AC-50 production deploy (CDK synth)", () => {
  it(
    "synthesizes Indeedee stack with API, sync, web, and CloudFront",
    () => {
      cover("AC-50");

      expect(existsSync(join(repoRoot, "DEPLOY.md"))).toBe(true);
      expect(existsSync(join(infraDir, "lib/indeedee-stack.ts"))).toBe(true);

      execSync("pnpm synth", {
        cwd: infraDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CDK_DEFAULT_ACCOUNT: process.env.CDK_DEFAULT_ACCOUNT ?? "111111111111",
          CDK_DEFAULT_REGION: process.env.CDK_DEFAULT_REGION ?? "us-east-2",
          INDEEDEE_DB_URL: "libsql://test.turso.io",
        },
      });

      const templatePath = join(infraDir, "cdk.out", "Indeedee-dev.template.json");
      expect(existsSync(templatePath)).toBe(true);

      const template = readFileSync(templatePath, "utf8");
      expect(template).toContain("AWS::Lambda::Function");
      expect(template).toContain("AWS::ApiGatewayV2::Api");
      expect(template).toContain("AWS::CloudFront::Distribution");
      expect(template).toContain("AWS::Events::Rule");
      expect(template).toContain("AWS::SecretsManager::Secret");
    },
    120_000,
  );
});
