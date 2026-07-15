#!/usr/bin/env bash
# Build images, push to ECR, upload artifacts, deploy/update CloudFormation stack.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

REGION="${AWS_REGION:-us-east-1}"
PROJECT="${PROJECT_NAME:-oracle-property-intelligence}"
STACK="${STACK_NAME:-${PROJECT}-prod}"
TEMPLATE="${PROJECT_ROOT}/deploy/aws/template.yaml"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require aws
require docker

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_UI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${PROJECT}-ui"
ECR_MCP="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${PROJECT}-mcp"

echo "== 1. Pipeline artifacts =="
if [[ ! -f "${PROJECT_ROOT}/data/properties.parquet" ]]; then
  python3 -m pipeline.run
fi

echo "== 2. ECR repositories =="
for repo in "${PROJECT}-ui" "${PROJECT}-mcp"; do
  aws ecr describe-repositories --repository-names "${repo}" --region "${REGION}" >/dev/null 2>&1 \
    || aws ecr create-repository --repository-name "${repo}" --region "${REGION}" >/dev/null
done

aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "== 3. Build & push images =="
docker build -f "${PROJECT_ROOT}/deploy/ui/Dockerfile" -t "${ECR_UI}:latest" "${PROJECT_ROOT}"
docker build -f "${PROJECT_ROOT}/deploy/mcp/Dockerfile" -t "${ECR_MCP}:latest" "${PROJECT_ROOT}"
docker push "${ECR_UI}:latest"
docker push "${ECR_MCP}:latest"

echo "== 4. Deploy CloudFormation stack =="
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  ACTION=update-stack
else
  ACTION=create-stack
fi

set +e
aws cloudformation "${ACTION}" \
  --stack-name "${STACK}" \
  --template-body "file://${TEMPLATE}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "${REGION}" \
  --parameters \
    ParameterKey=UiImageUri,ParameterValue="${ECR_UI}:latest" \
    ParameterKey=McpImageUri,ParameterValue="${ECR_MCP}:latest"
CFN_EXIT=$?
set -e
if [[ "${CFN_EXIT}" -ne 0 ]]; then
  echo "CloudFormation ${ACTION} skipped or no changes (exit ${CFN_EXIT})"
fi

echo "Waiting for stack..."
aws cloudformation wait stack-create-complete --stack-name "${STACK}" --region "${REGION}" 2>/dev/null \
  || aws cloudformation wait stack-update-complete --stack-name "${STACK}" --region "${REGION}"

BUCKET="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue" --output text)"
ALB_URL="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='LoadBalancerUrl'].OutputValue" --output text)"

echo "== 5. Upload artifacts to s3://${BUCKET}/artifacts/ =="
aws s3 cp "${PROJECT_ROOT}/data/properties.parquet" "s3://${BUCKET}/artifacts/properties.parquet"
aws s3 cp "${PROJECT_ROOT}/data/run_summary.json" "s3://${BUCKET}/artifacts/run_summary.json"
aws s3 cp "${PROJECT_ROOT}/manifest.json" "s3://${BUCKET}/artifacts/manifest.json"

echo "== 6. Force new ECS deployment =="
CLUSTER="${PROJECT}-cluster"
aws ecs update-service --cluster "${CLUSTER}" --service "${PROJECT}-ui" --force-new-deployment --region "${REGION}" >/dev/null
aws ecs update-service --cluster "${CLUSTER}" --service "${PROJECT}-mcp" --force-new-deployment --region "${REGION}" >/dev/null

echo
echo "Deployed."
echo "  UI:  ${ALB_URL}"
echo "  MCP: ${ALB_URL}/mcp"
echo "  S3:  s3://${BUCKET}/artifacts/"
