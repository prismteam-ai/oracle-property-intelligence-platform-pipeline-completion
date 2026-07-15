import { runSync } from "./runtime.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Background autosync for SLA goal (AC-22) — runs per configured owner. */
export function startSyncScheduler() {
  const intervalMs = Number(process.env.SYNC_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (intervalMs <= 0) return;

  const owners = (process.env.SYNC_OWNER_IDS ?? "demo-owner")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const tick = async () => {
    for (const ownerId of owners) {
      try {
        await runSync(ownerId);
      } catch (err) {
        console.error(`[sync-scheduler] ${ownerId}:`, err instanceof Error ? err.message : err);
      }
    }
  };

  console.log(`[sync-scheduler] every ${intervalMs / 1000}s for owners: ${owners.join(", ")}`);
  setInterval(tick, intervalMs);
}
