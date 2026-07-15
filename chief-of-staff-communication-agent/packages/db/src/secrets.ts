import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Channel } from "@indeedee/shared";

export type SecretsBackend = "local" | "secrets-manager";

const ENC_PREFIX = "enc:v1:";
const SM_PREFIX = "sm:v1:";

const SECRET_FIELD_NAMES = new Set([
  "password",
  "refreshToken",
  "accessToken",
  "authToken",
  "asanaPat",
  "clientSecret",
  "apiKey",
  "apiSecret",
  "token",
  "secret",
]);

let smClient: SecretsManagerClient | null = null;

export function resolveSecretsBackend(): SecretsBackend {
  const mode = process.env.INDEEDEE_SECRETS_BACKEND?.toLowerCase();
  if (mode === "secrets-manager") return "secrets-manager";
  return "local";
}

export function resetSecretsClientsForTests(): void {
  smClient = null;
}

export function setSecretsManagerClientForTests(client: SecretsManagerClient | null): void {
  smClient = client;
}

function getSecretsManagerClient(): SecretsManagerClient {
  if (smClient) return smClient;
  smClient = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? "us-east-2",
  });
  return smClient;
}

function getLocalKey(): Buffer {
  const raw = process.env.INDEEDEE_SECRETS_KEY;
  if (!raw) {
    throw new Error(
      "INDEEDEE_SECRETS_KEY is required for local credential encryption (32-byte base64)",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("INDEEDEE_SECRETS_KEY must decode to 32 bytes for AES-256-GCM");
  }
  return key;
}

function secretName(ownerId: string, channel: Channel, accountHandle: string): string {
  const prefix = process.env.INDEEDEE_SECRETS_PREFIX ?? "indeedee";
  const safeOwner = ownerId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeHandle = accountHandle.replace(/[^a-zA-Z0-9@._-]/g, "_");
  return `${prefix}/${safeOwner}/${channel}/${safeHandle}`;
}

function sealLocal(credentials: Record<string, string>): string {
  const key = getLocalKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(credentials);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

function unsealLocal(stored: string): Record<string, string> {
  const payload = stored.slice(ENC_PREFIX.length);
  const buf = Buffer.from(payload, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const key = getLocalKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as Record<string, string>;
}

async function sealSecretsManager(
  ownerId: string,
  channel: Channel,
  accountHandle: string,
  credentials: Record<string, string>,
): Promise<string> {
  const name = secretName(ownerId, channel, accountHandle);
  const client = getSecretsManagerClient();
  const secretString = JSON.stringify(credentials);
  try {
    await client.send(
      new PutSecretValueCommand({
        SecretId: name,
        SecretString: secretString,
      }),
    );
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code !== "ResourceNotFoundException") throw err;
    await client.send(
      new CreateSecretCommand({
        Name: name,
        SecretString: secretString,
        Description: `Indeedee connector credentials for ${ownerId}/${channel}`,
      }),
    );
  }
  return `${SM_PREFIX}${name}`;
}

async function unsealSecretsManager(stored: string): Promise<Record<string, string>> {
  const name = stored.slice(SM_PREFIX.length);
  const client = getSecretsManagerClient();
  const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
  if (!res.SecretString) throw new Error(`Secret ${name} has no string payload`);
  return JSON.parse(res.SecretString) as Record<string, string>;
}

async function deleteSecretsManager(stored: string): Promise<void> {
  if (!stored.startsWith(SM_PREFIX)) return;
  const name = stored.slice(SM_PREFIX.length);
  const client = getSecretsManagerClient();
  try {
    await client.send(
      new DeleteSecretCommand({
        SecretId: name,
        ForceDeleteWithoutRecovery: true,
      }),
    );
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code !== "ResourceNotFoundException") throw err;
  }
}

export async function sealConnectorCredentials(input: {
  ownerId: string;
  channel: Channel;
  accountHandle: string;
  credentials: Record<string, string>;
}): Promise<string> {
  if (resolveSecretsBackend() === "secrets-manager") {
    return sealSecretsManager(
      input.ownerId,
      input.channel,
      input.accountHandle,
      input.credentials,
    );
  }
  return sealLocal(input.credentials);
}

export async function unsealConnectorCredentials(stored: string): Promise<Record<string, string>> {
  if (stored.startsWith(ENC_PREFIX)) return unsealLocal(stored);
  if (stored.startsWith(SM_PREFIX)) return unsealSecretsManager(stored);
  if (stored.trimStart().startsWith("{")) {
    return JSON.parse(stored) as Record<string, string>;
  }
  throw new Error("Unrecognized connector credential blob format");
}

export async function deleteConnectorSecretBlob(stored: string): Promise<void> {
  if (stored.startsWith(SM_PREFIX)) await deleteSecretsManager(stored);
}

export function redactCredentials(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_NAMES.has(key) || /secret|token|password|pat/i.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactCredentials(child);
      }
    }
    return out;
  }
  return value;
}

export function isEncryptedCredentialBlob(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX) || stored.startsWith(SM_PREFIX);
}
