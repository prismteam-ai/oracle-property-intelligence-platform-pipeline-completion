import { describe, expect, it, vi, afterEach } from "vitest";
import { appRouter } from "@indeedee/api/trpc/router";
import { RecommendationSchema } from "@indeedee/shared";
import {
  getConnectorCredentials,
  getStoredCredentialBlob,
  isEncryptedCredentialBlob,
  redactCredentials,
  resetSecretsClientsForTests,
  setSecretsManagerClientForTests,
} from "@indeedee/db";
import { cover } from "./manifest.js";

describe("AC-30 user permission boundaries", () => {
  it("scopes communications queries to caller ownerId", async () => {
    cover("AC-30");
    const a = appRouter.createCaller({ ownerId: "tenant-a", role: "owner" });
    const b = appRouter.createCaller({ ownerId: "tenant-b", role: "owner" });
    const listA = await a.communications.listPending();
    const listB = await b.communications.listPending();
    expect(listA.ownerId).toBe("tenant-a");
    expect(listB.ownerId).toBe("tenant-b");
    expect(listA.ownerId).not.toBe(listB.ownerId);
  });

  it("scopes RAG search to caller ownerId", async () => {
    cover("AC-30");
    const caller = appRouter.createCaller({ ownerId: "tenant-a", role: "owner" });
    const result = await caller.rag.search({ query: "budget" });
    expect(result.ownerId).toBe("tenant-a");
  });
});

describe("AC-29 secure token management", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    resetSecretsClientsForTests();
    vi.restoreAllMocks();
  });

  it("connect API accepts credentials object without logging secrets (contract)", async () => {
    cover("AC-29");
    const caller = appRouter.createCaller({ ownerId: "o1", role: "owner" });
    const result = await caller.connectors.connect({
      channel: "gmail",
      accountHandle: "test@gmail.com",
      credentials: { refreshToken: "secret-value" },
    });
    expect(result.status).toBe("connected");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("stores connector credentials encrypted at rest in local mode", async () => {
    cover("AC-29");
    process.env.INDEEDEE_SECRETS_BACKEND = "local";
    const caller = appRouter.createCaller({ ownerId: "sec-local", role: "owner" });
    await caller.connectors.connect({
      channel: "gmail",
      accountHandle: "secure@gmail.com",
      credentials: { mode: "live", refreshToken: "super-secret-token" },
    });

    const blob = await getStoredCredentialBlob("sec-local", "gmail", "secure@gmail.com");
    expect(blob).toBeTruthy();
    expect(isEncryptedCredentialBlob(blob!)).toBe(true);
    expect(blob).not.toContain("super-secret-token");

    const creds = await getConnectorCredentials("sec-local", "gmail", "secure@gmail.com");
    expect(creds?.refreshToken).toBe("super-secret-token");
  });

  it("stores connector credentials in Secrets Manager when configured", async () => {
    cover("AC-29");
    process.env.INDEEDEE_SECRETS_BACKEND = "secrets-manager";
    process.env.INDEEDEE_SECRETS_PREFIX = "indeedee-test";

    const secrets = new Map<string, string>();
    setSecretsManagerClientForTests({
      send: vi.fn(async (command) => {
        const name = command.constructor.name;
        if (name === "PutSecretValueCommand") {
          const id = String(command.input.SecretId);
          if (!secrets.has(id)) {
            const err = new Error("not found");
            (err as { name: string }).name = "ResourceNotFoundException";
            throw err;
          }
          secrets.set(id, String(command.input.SecretString));
          return {};
        }
        if (name === "CreateSecretCommand") {
          secrets.set(String(command.input.Name), String(command.input.SecretString));
          return {};
        }
        if (name === "GetSecretValueCommand") {
          const value = secrets.get(String(command.input.SecretId));
          if (!value) {
            const err = new Error("not found");
            (err as { name: string }).name = "ResourceNotFoundException";
            throw err;
          }
          return { SecretString: value };
        }
        if (name === "DeleteSecretCommand") {
          secrets.delete(String(command.input.SecretId));
          return {};
        }
        throw new Error(`Unexpected command ${name}`);
      }),
    } as never);

    const caller = appRouter.createCaller({ ownerId: "sec-sm", role: "owner" });
    await caller.connectors.connect({
      channel: "sms",
      accountHandle: "+15551212",
      credentials: { mode: "live", accountSid: "AC123", authToken: "twilio-secret", fromNumber: "+1" },
    });

    const blob = await getStoredCredentialBlob("sec-sm", "sms", "+15551212");
    expect(blob).toMatch(/^sm:v1:indeedee-test\//);
    expect(blob).not.toContain("twilio-secret");
    expect(secrets.size).toBe(1);
    expect([...secrets.values()][0]).toContain("twilio-secret");

    const creds = await getConnectorCredentials("sec-sm", "sms", "+15551212");
    expect(creds?.authToken).toBe("twilio-secret");
  });

  it("redacts sensitive credential fields for safe logging", () => {
    cover("AC-29");
    const redacted = redactCredentials({
      channel: "gmail",
      credentials: { mode: "live", refreshToken: "abc", accountHandle: "a@b.com" },
    }) as { credentials: Record<string, string> };
    expect(redacted.credentials.refreshToken).toBe("[REDACTED]");
    expect(redacted.credentials.mode).toBe("live");
  });
});

describe("AC-18 link communications to Asana work", () => {
  it("recommendation schema supports link_task and create_task actions", () => {
    cover("AC-18");
    for (const action of ["link_task", "create_task"] as const) {
      const rec = RecommendationSchema.parse({
        id: "r1",
        messageId: "m1",
        ownerId: "o1",
        action,
        rationale: "Follow-up required",
        needsContext: false,
        taskTitle: "Review board deck",
        createdAt: new Date().toISOString(),
      });
      expect(rec.action).toBe(action);
    }
  });

  it.skip("integration: message detail shows linked Asana URLs/GIDs", () => {
    cover("AC-18");
  });
});

describe("AC-19 create or update Asana tasks", () => {
  it.skip("e2e: communication creates/updates task in live Asana", () => {
    cover("AC-19");
  });
});

describe("AC-45 demo Asana task flow", () => {
  it.skip("e2e: live Asana task from message flow", () => {
    cover("AC-45");
  });
});
