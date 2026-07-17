# ADR 0001: Reproducible serverless foundation

Status: Accepted

## Context

The assessment needs a hosted product foundation immediately, while the county pipeline, DuckDB
query layer, and MCP implementation belong to later work. The foundation must not imply that those
capabilities already exist.

## Decision

Use an exact-pinned Node 22.18.0, Corepack 0.34.6, pnpm 10.33.0, TypeScript 5.9.3 Turborepo. Keep
contracts and observability in shared packages, and keep the web, API, MCP, and pipeline entrypoints
independently deployable and testable. Host the static Vite app from a private S3 origin through
CloudFront Origin Access Control. Route typed API and foundation-only MCP traffic through an HTTP
API to separate Node 22 Lambdas. Synthesize one foundation stack with no context lookups.

## Tradeoffs

CloudFront plus private S3 takes more CDK than Amplify, but provides a stable low-idle-cost URL and
an explicit private-origin boundary. The foundation exposes one narrow typed operation instead of
creating speculative domain packages. Powertools and X-Ray are included now because observability
is a cross-cutting runtime boundary; business metrics wait for real business operations and their
required catalog/dashboard registration. DuckDB, data stores, queues, model providers, and the MCP
SDK wait until their graded verticals so this scaffold makes no false data or protocol claims.

## Consequences

Later work can add source adapters, canonical data, queries, and an MCP protocol implementation
behind stable app/package boundaries without replacing the workspace or hosting topology. Until
then, every user-facing surface explicitly reports foundation-only status.
