# Deploying Indeedee to AWS

Production deploy uses AWS CDK (`infra/`) to provision:

- **HTTP API + Lambda** — REST, auth, tRPC, and MCP routes
- **EventBridge + Lambda** — scheduled channel sync (every 5 minutes)
- **S3 + CloudFront** — static UI with `/api/*` and `/mcp/*` proxied to the API
- **Secrets Manager** — app secret + connector credential storage (`INDEEDEE_SECRETS_BACKEND=secrets-manager`)

## Prerequisites

1. AWS account with CDK bootstrapped in the target region (default `us-east-2`):

   ```bash
   npx aws-cdk bootstrap aws://ACCOUNT_ID/us-east-2
   ```

2. **Turso** (or other remote libSQL) database URL for Lambda persistence — ephemeral `/tmp` is not suitable for production.

3. **Google OAuth** credentials with authorized redirect URIs:
   - `https://YOUR_CLOUDFRONT_DOMAIN/api/auth/google/callback` (SSO login)
   - `https://YOUR_CLOUDFRONT_DOMAIN/api/oauth/google/callback` (Gmail connector)

4. Node.js 20+ and pnpm 10+ locally (or use CI).

## First deploy

```bash
pnpm install
pnpm build

export CDK_DEFAULT_ACCOUNT=YOUR_AWS_ACCOUNT_ID
export CDK_DEFAULT_REGION=us-east-2
export INDEEDEE_DB_URL="libsql://your-db.turso.io?authToken=..."
export SYNC_OWNER_IDS="owner-user-id"

pnpm --filter @indeedee/infra deploy
```

Note the stack outputs:

| Output | Use |
|--------|-----|
| `SiteUrl` | Public app URL (CloudFront) |
| `HttpApiUrl` | Direct API Gateway URL (debugging) |
| `AppSecretArn` | Populate runtime secrets after deploy |

## Post-deploy configuration

1. Open **Secrets Manager** → secret `indeedee/{stage}/app` and add JSON keys as needed:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `INDEEDEE_SESSION_SECRET` (32+ char random string)
   - `INDEEDEE_OWNER_EMAILS` (comma-separated owner emails)
   - `ASANA_PAT` (optional)

2. Update Google Cloud Console redirect URIs to match `SiteUrl` callbacks.

3. Set Lambda environment overrides if not passed at deploy time:
   - `INDEEDEE_DB_URL` — remote libSQL URL
   - `SYNC_OWNER_IDS` — comma-separated owner IDs to sync

4. For Bedrock brain, ensure the Lambda role can invoke Bedrock in your region (stack grants `bedrock:InvokeModel`).

## CI/CD

GitHub Actions caller workflows in `.github/workflows/` invoke the shared Soofi XYZ pipeline:

- **DEV** — on pull requests to `main`
- **PROD** — on merge to `main`

The pipeline runs `just` recipes: `format` → `lint` → `type-check` → `test` → `build` → `deploy`.

Set repository secrets / OIDC for AWS deploy in the org `github-workflows` setup.

## Local vs production

| Concern | Local (`pnpm dev`) | Production (CDK) |
|---------|-------------------|------------------|
| UI + API | Single Node server on `:8787` | CloudFront + Lambda |
| Database | `file:data/indeedee.db` | Remote libSQL (Turso) |
| Autosync | In-process scheduler | EventBridge every 5 min |
| Secrets | Local AES (`INDEEDEE_SECRETS_KEY`) | AWS Secrets Manager |
| Auth | Optional Google SSO | Google SSO enabled |

## Synth-only (no AWS credentials)

```bash
CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=us-east-2 pnpm --filter @indeedee/infra synth
```

Acceptance test `tests/acceptance/deploy.test.ts` runs this smoke check in CI.

## Tear down

```bash
pnpm --filter @indeedee/infra exec cdk destroy --force
```
