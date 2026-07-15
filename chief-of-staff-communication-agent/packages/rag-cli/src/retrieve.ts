#!/usr/bin/env node
/**
 * Local RAG retrieve CLI (build-local-rag-pocs / espeon Phase 1).
 * Query-only — agents call this from Cursor before recommending or drafting.
 *
 * Usage:
 *   node packages/rag-cli/dist/retrieve.js "<query>" [--owner-id ID] [--top-k N] [--json]
 */
import "dotenv/config";
import { createClient } from "@libsql/client";
import { z } from "zod";

const ArgsSchema = z.object({
  query: z.string().min(1),
  ownerId: z.string().default("local"),
  topK: z.coerce.number().int().min(1).max(20).default(5),
  json: z.boolean().default(false),
});

function parseArgs(argv: string[]) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--") && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      flags.set(arg.slice(2), argv[i + 1]!);
      i++;
    } else if (arg === "--json") {
      flags.set("json", "true");
    }
  }
  return ArgsSchema.parse({
    query: positional[0] ?? "",
    ownerId: flags.get("owner-id") ?? "local",
    topK: flags.get("top-k") ?? 5,
    json: flags.has("json"),
  });
}

/** Simple keyword overlap rank until Bedrock embeddings are wired. */
function score(query: string, text: string): number {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = text.toLowerCase();
  let hits = 0;
  for (const term of q) {
    if (hay.includes(term)) hits++;
  }
  return q.length ? hits / q.length : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = process.env.INDEEDEE_RAG_DB ?? "data/indeedee-rag.db";
  const db = createClient({ url: `file:${dbPath}` });

  await db.execute(`
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT,
      text_for_context TEXT NOT NULL,
      metadata_json TEXT DEFAULT '{}'
    )
  `);

  const rows = await db.execute({
    sql: "SELECT * FROM rag_chunks WHERE owner_id = ?",
    args: [args.ownerId],
  });

  const ranked = rows.rows
    .map((row) => {
      const text = String(row.text_for_context ?? "");
      return {
        id: String(row.id),
        sourceType: String(row.source_type),
        sourceId: String(row.source_id),
        title: row.title ? String(row.title) : undefined,
        text,
        score: score(args.query, text),
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, args.topK);

  if (args.json) {
    console.log(JSON.stringify(ranked, null, 2));
    return;
  }

  if (ranked.length === 0) {
    console.log("No matches. Index communications with `indeedee-rag index` (coming soon).");
    return;
  }

  for (const [i, hit] of ranked.entries()) {
    console.log(`#${i + 1} [${hit.sourceType} | score ${hit.score.toFixed(2)}] ${hit.title ?? hit.sourceId}`);
    console.log(hit.text.slice(0, 500));
    console.log("");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
