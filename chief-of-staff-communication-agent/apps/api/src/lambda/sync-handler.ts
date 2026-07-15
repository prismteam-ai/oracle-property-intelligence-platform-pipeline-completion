import type { ScheduledEvent, Context } from "aws-lambda";
import { migrate } from "@indeedee/db";
import { runSync } from "../services/runtime.js";

let migrated = false;

export async function handler(_event: ScheduledEvent, _context: Context) {
  if (!migrated) {
    await migrate();
    migrated = true;
  }

  const owners = (process.env.SYNC_OWNER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const results = [];
  for (const ownerId of owners) {
    try {
      const result = await runSync(ownerId);
      results.push({ ownerId, status: "ok", ingested: result.ingest.ingested });
    } catch (err) {
      results.push({
        ownerId,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(JSON.stringify({ event: "indeedee-sync", results }));
  return { ok: true, results };
}
