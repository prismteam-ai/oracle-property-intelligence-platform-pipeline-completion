# AWS deployment

Near-zero standing database cost: **S3 parquet + ECS Fargate** serving Flask UI and `@elephant-xyz/mcp`.

## Architecture

```
S3 (artifacts) ──► ECS Fargate UI (gunicorn + DuckDB over parquet)
                └──► ECS Fargate MCP (elephant-mcp queryProperties)
                         ▲
                   ALB :80  / → UI
                        /mcp → MCP
```

No RDS, no Neon on AWS.

## Prerequisites

- AWS account with CLI configured (`aws sts get-caller-identity`)
- Docker
- Pipeline run locally: `./scripts/run.sh pipeline`

## One-command deploy

```bash
chmod +x scripts/deploy-aws.sh
./scripts/deploy-aws.sh
```

This will:

1. Build UI + MCP Docker images
2. Push to ECR (`oracle-property-intelligence-ui`, `oracle-property-intelligence-mcp`)
3. Create/update CloudFormation stack (`deploy/aws/template.yaml`)
4. Upload `properties.parquet`, `run_summary.json`, `manifest.json` to S3
5. Roll ECS services

## Outputs

After deploy, note:

- **UI:** `http://<alb-dns>/`
- **MCP:** `http://<alb-dns>/mcp`
- **Demo pages:** `/run`, `/search`, `/about`, `/ask`

## Local Docker (pre-AWS smoke test)

```bash
docker compose up --build
```

Uses mounted `./data` — same images as AWS.

## Cost notes

- **Fargate:** 2 tasks × 0.25 vCPU / 512 MB (~$15–25/mo if always on)
- **ALB:** ~$16/mo + LCU
- **S3:** pennies for ~100 MB artifacts

To reduce cost after demo: set ECS `DesiredCount` to 0 or delete the stack.

## Optional: HTTPS

Add ACM certificate + ALB HTTPS listener (443) pointing to same target groups.

## Environment overrides

| Variable | Default |
|----------|---------|
| `AWS_REGION` | `us-east-1` |
| `STACK_NAME` | `oracle-property-intelligence-prod` |
| `PROJECT_NAME` | `oracle-property-intelligence` |

## Demo URL in submission

Put the ALB URL in your PR/demo video. Update `UI_BASE_URL` / `MCP_BASE_URL` if you bake them into a future build — containers receive `MCP_BASE_URL` from the stack for the UI task.
