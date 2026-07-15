# Indeedee Agent — Setup

Chief of Staff Communication Agent built on the [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit).

## Quick start (demo — no OAuth)

```bash
pnpm install
pnpm build
cp .env.example .env
# Optional: set INDEEDEE_SSO_ENABLED=false in .env to skip Google login in local dev
pnpm --filter @indeedee/api dev
```

Open http://localhost:8787

1. Click **Connect demo channels** (Gmail, email, SMS, WhatsApp, X)
2. Click **Sync & run agents**
3. Review **Incoming** recommendations and **Approvals** queue
4. **Approve & send** (owner mode only)

## Environment

| Variable | Purpose |
|----------|---------|
| `INDEEDEE_DB_URL` | libSQL database (default `file:data/indeedee.db`) |
| `PORT` | API + UI port (default `8787`) |
| `SYNC_INTERVAL_MS` | Background autosync interval (default `300000`, `0` disables) |
| `SYNC_OWNER_IDS` | Comma-separated owner ids for autosync (default `demo-owner`) |
| `INDEEDEE_SECRETS_BACKEND` | `local` (AES-256-GCM in libSQL) or `secrets-manager` (AWS) |
| `INDEEDEE_SECRETS_KEY` | 32-byte base64 key — required for `local` backend when storing live credentials |
| `INDEEDEE_SECRETS_PREFIX` | Secret name prefix when using Secrets Manager (default `indeedee`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth live connect + Google SSO login |
| `GOOGLE_SSO_REDIRECT_URI` | SSO callback (default `/api/auth/google/callback`) |
| `INDEEDEE_SSO_ENABLED` | `true` when Google creds set; set `false` for dev header auth |
| `INDEEDEE_SESSION_SECRET` | HMAC secret for signed session cookies |
| `INDEEDEE_OWNER_EMAILS` | Comma-separated emails granted owner role (others are viewers) |
| `ASANA_PAT` | Asana personal access token (demo mode if unset) |
| `AWS_*` / `BEDROCK_*` | Optional Bedrock for future LLM brain |

## Cursor / MCP

Configure `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "indeedee": {
      "url": "http://localhost:8787/mcp/tools/call",
      "headers": { "X-Owner-Id": "demo-owner", "X-Role": "owner" }
    }
  }
}
```

Tools: `retrieve_context`, `list_pending`, `recommend_and_draft`, `approve_and_send`, `create_asana_task`, `sync`, `dashboard_stats`.

## Tests

```bash
pnpm build && pnpm test
```

Acceptance tests map 1:1 to `ACCEPTANCE_CRITERIA.md`.

## Production deploy

See [DEPLOY.md](./DEPLOY.md) for AWS CDK deployment (Lambda, CloudFront, EventBridge sync, Secrets Manager).

## Demo video

Record a UI walkthrough (Dashboard → Demo channels → Incoming → People → Approvals → Connections → MCP):

```bash
# Terminal 1 — requires INDEEDEE_SECRETS_KEY in .env (see .env.example)
INDEEDEE_SSO_ENABLED=false pnpm --filter @indeedee/api dev

# Terminal 2
pnpm exec playwright install chromium   # once
node scripts/record-ui-demo.mjs
```

Output: [`demo/indeedee-chief-of-staff-demo.webm`](demo/indeedee-chief-of-staff-demo.webm)

Optional voiceover: `python3 scripts/add-demo-narration.py` (requires `edge-tts`, `imageio-ffmpeg`).

## Production channels

Replace demo credentials with real OAuth/tokens via **Connections** API or tRPC `connectors.connect`. LinkedIn is intentionally unavailable (no compliant public messaging API).
