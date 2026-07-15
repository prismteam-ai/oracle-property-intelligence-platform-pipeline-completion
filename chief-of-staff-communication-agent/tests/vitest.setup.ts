import { beforeAll } from "vitest";
import { migrate, resetDb } from "@indeedee/db";

process.env.INDEEDEE_DB_URL = "file::memory:";
process.env.INDEEDEE_SECRETS_BACKEND = "local";
process.env.INDEEDEE_SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.INDEEDEE_SSO_ENABLED = "false";

beforeAll(async () => {
  resetDb();
  await migrate();
});
