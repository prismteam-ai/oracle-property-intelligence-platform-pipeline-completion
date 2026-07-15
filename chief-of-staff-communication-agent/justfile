set dotenv-load := false

# Install dependencies
setup:
    pnpm install

# Format check (TypeScript strict mode via compiler)
format:
    pnpm typecheck

# Lint via TypeScript project references
lint:
    pnpm typecheck

# Type-check all packages
type-check:
    pnpm typecheck

# Run acceptance tests
test:
    cp -n .env.example .env 2>/dev/null || true
    pnpm build && pnpm test

# Build packages and synthesize CDK stack
build:
    pnpm build
    CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=us-east-2 pnpm --filter @indeedee/infra synth

# Deploy CDK stack to AWS
deploy:
    pnpm --filter @indeedee/infra deploy
