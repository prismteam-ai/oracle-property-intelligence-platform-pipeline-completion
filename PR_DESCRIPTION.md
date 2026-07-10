# Oracle Property Intelligence Platform — Pipeline Completion

Real Santa Clara County / Palo Alto property intelligence over DuckDB + IPFS, queryable from a UI, an agent, and MCP, with no hosted database (the dataset lives on IPFS/GCS and is read on demand).

## Demo
https://youtu.be/upqvH2OVsr8

## Live app (hosted, not localhost)
- URL: http://89.167.5.247:8091
- Login: `owner` / `owner1234` (or read-only `demo` / `demo1234`)
- No OAuth required.

## What it does (6 questions)
| Question | Data |
|---|---|
| Roofs > 15 years | real (permit history) |
| View of water | real (OSM proximity heuristic) |
| Near public transit | real |
| Near a Starbucks | real |
| No sale in 10+ years | proxy — permit dormancy (labeled) |
| Regional (out-of-area) owner | data gap — flagged, not faked |

## Caveats (honest by design)
- Owner mailing address (regional owner) and exact last-sale date are not free open data in California (R&T Code §408). Those two questions are handled transparently: the sale question uses a labeled permit-dormancy proxy, and the owner question returns nothing with the reason shown. Supply an owner/sale CSV and both light up with no code change.
- Permit data starts 2013, so "roof > 15yr" means no roofing permit in the last 15 years.
- The city's advertised permit host (`api.data.paloalto.gov`) is dead; the pipeline uses the live portal export path (documented in the run summary).

## Where the data lives
- GCS bucket (primary): `gs://dmitriy-konyrev-oracle-property/` -> `https://storage.googleapis.com/dmitriy-konyrev-oracle-property/properties.parquet`
- IPFS (Filebase, decentralized): CIDs in [`manifest.json`](manifest.json) and on the app's IPFS artifacts tab. `properties.parquet` -> `https://ipfs.filebase.io/ipfs/QmYa6qQA4VNY2HZzt25ABHMziaZeTz128Y476cF3iAUtF6`
- The Parquet is not committed — `npm run fetch-data` pulls it (GCS, with IPFS fallback).

## How to run
```bash
cp web/.env.example web/.env.local     # fill in the envs below
docker compose up -d --build           # WEB_PORT=8091 to change port
# open http://localhost:3100  (login owner / owner1234)
```
The Docker build runs `fetch-data` automatically. The 6 preset questions work with no key; the "Ask the data" agent needs `ANTHROPIC_API_KEY`.

## Required envs (`web/.env.local`)
| Var | Purpose |
|---|---|
| `AUTH_JWT_SECRET` | session signing (any long random string) |
| `ANTHROPIC_API_KEY` | the intent + answer agents (`claude-sonnet-5`) |
| `ANTHROPIC_MODEL` | optional, defaults to `claude-sonnet-5` |
| `DEMO_OWNER_USER` / `DEMO_OWNER_PASS` / `DEMO_VIEWER_USER` / `DEMO_VIEWER_PASS` | demo logins (defaults: owner/owner1234, demo/demo1234) |
| `DATA_URL` | optional, override the parquet source |
| `COOKIE_SECURE` | `false` for local HTTP |

For pipeline re-runs and Filebase publishing, see `pipeline/.env.example`.

## MCP
Any agent (Cursor / Claude Desktop / Claude Code / Codex) can query the dataset over MCP. Configs in [`MCP.md`](MCP.md) and the in-app Connect via MCP panel.

## Docs
`README.md` (overview + run), `MCP.md` (MCP), `FINDINGS.md` (relevance evals: 100% intent exact-match, 4.0/5 judge), `ASSIGNMENT.md` (brief).

---
Note: repo history was cleaned (node_modules purged); push with `git push -u fork test-task-dmitrii-konyrev -f`.
