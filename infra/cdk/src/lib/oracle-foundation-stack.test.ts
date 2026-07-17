import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';

import { OracleFoundationStack, type BedrockPromotion } from './oracle-foundation-stack.js';

const app = new cdk.App();
const templateTestCode = lambda.Code.fromInline(
  'exports.handler = async () => ({ statusCode: 503, body: "template-test-only" });',
);
const stack = new OracleFoundationStack(app, 'TestStack', {
  env: { account: '417242953053', region: 'us-east-2' },
  testOnlyFunctionCodeOverride: templateTestCode,
});
const foundationTemplate = Template.fromStack(stack);

interface SynthesizedResource {
  Type?: string;
  Properties?: {
    Architectures?: string[];
    Code?: { S3Key?: string };
    Environment?: { Variables?: Record<string, unknown> };
    Handler?: string;
    Runtime?: string;
  };
}

interface SynthesizedTemplate {
  Resources: Record<string, SynthesizedResource>;
}

interface GatewayEvent {
  version: '2.0';
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    domainPrefix: string;
    http: {
      method: string;
      path: string;
      protocol: string;
      sourceIp: string;
      userAgent: string;
    };
    requestId: string;
    routeKey: string;
    stage: string;
    time: string;
    timeEpoch: number;
  };
  isBase64Encoded: false;
}

const healthPaths: Record<string, string> = {
  'oracle-application-api': '/health',
  'oracle-named-evidence-mcp': '/mcp/health',
};
const handlers: Record<string, string> = {
  'oracle-application-api': 'api.handler',
  'oracle-named-evidence-mcp': 'mcp.handler',
};

function gatewayEvent(rawPath: string): GatewayEvent {
  const routeKey = `GET ${rawPath}`;

  return {
    version: '2.0',
    routeKey,
    rawPath,
    rawQueryString: '',
    headers: { accept: 'application/json' },
    requestContext: {
      accountId: 'test-account',
      apiId: 'test-api',
      domainName: 'test.execute-api.local',
      domainPrefix: 'test',
      http: {
        method: 'GET',
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'test-request',
      routeKey,
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 1_767_225_600_000,
    },
    isBase64Encoded: false,
  };
}

function productRolePolicies(template: Template): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(template.findResources('AWS::IAM::Policy')).filter(([, resource]) => {
      const encoded = JSON.stringify(resource);
      return (
        encoded.includes('ApiFunctionServiceRole') || encoded.includes('McpFunctionServiceRole')
      );
    }),
  );
}

const repositoryRoot = resolve(import.meta.dirname, '../../../../');
const testReleaseDirectory = resolve(
  repositoryRoot,
  'infra/cdk/test-fixtures/generated-public-release',
);
const testReleaseGenerator = resolve(
  repositoryRoot,
  'infra/cdk/test-fixtures/create-public-release.mts',
);

describe('Oracle product infrastructure', () => {
  it('uses three private, encrypted, versioned, object-locked buckets', () => {
    foundationTemplate.resourceCountIs('AWS::S3::Bucket', 3);
    foundationTemplate.allResourcesProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE' } },
      },
      ObjectLockEnabled: true,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('rewrites only legitimate SPA deep links and preserves API, MCP, asset, and file misses', () => {
    foundationTemplate.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
    foundationTemplate.resourceCountIs('AWS::CloudFront::Distribution', 2);
    const distributions = foundationTemplate.findResources('AWS::CloudFront::Distribution');
    expect(JSON.stringify(distributions)).not.toContain('CustomErrorResponses');
    expect(JSON.stringify(distributions)).toContain('FunctionAssociations');
    const functions = foundationTemplate.findResources('AWS::CloudFront::Function');
    expect(Object.values(functions)).toHaveLength(1);
    const functionCode = (Object.values(functions)[0]?.Properties as { FunctionCode?: unknown })
      .FunctionCode;
    expect(typeof functionCode).toBe('string');
    const rewrite = (uri: string): string => {
      const context: { event: { request: { uri: string } }; result?: { uri: string } } = {
        event: { request: { uri } },
      };
      runInNewContext(`${String(functionCode)}\nresult = handler(event);`, context);
      return context.result?.uri ?? '';
    };
    expect(rewrite('/properties/123')).toBe('/index.html');
    expect(rewrite('/inquiries/saved')).toBe('/index.html');
    for (const uri of [
      '/api/unknown',
      '/mcp/unknown',
      '/assets/missing',
      '/trpc/dataset.getInfo',
      '/health',
      '/health/unknown',
      '/dataset.getInfo',
      '/pipeline.getStatus',
      '/property.search',
      '/inquiry.roofAge',
      '/artifacts.list',
      '/agent.ask',
      '/missing.js',
    ]) {
      expect(rewrite(uri)).toBe(uri);
    }
    foundationTemplate.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: {
        CorsConfig: Match.objectLike({
          AccessControlAllowMethods: { Items: ['GET', 'HEAD', 'OPTIONS'] },
          AccessControlAllowOrigins: Match.anyValue(),
          OriginOverride: true,
        }),
      },
    });

    const deployments = foundationTemplate.findResources('Custom::CDKBucketDeployment');
    expect(JSON.stringify(deployments)).toContain('Prune');
    expect(JSON.stringify(deployments)).toContain('false');
  });

  it('exposes only the committed API and MCP routes with allowlisted CORS and throttling', () => {
    foundationTemplate.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    foundationTemplate.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: {
        AllowCredentials: false,
        AllowHeaders: ['authorization', 'content-type', 'x-request-id'],
        AllowMethods: ['GET', 'POST', 'OPTIONS'],
        MaxAge: 600,
      },
      ProtocolType: 'HTTP',
    });

    const routes = Object.values(foundationTemplate.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes).toHaveLength(5);
    expect(
      routes.map((route) => (route.Properties as { RouteKey: string }).RouteKey).sort(),
    ).toEqual(
      [
        'GET /health',
        'GET /mcp/health',
        'POST /mcp',
        'POST /trpc/{operation}',
        'POST /{operation}',
      ].sort(),
    );
    expect(JSON.stringify(routes)).not.toContain('ANY');
    expect(
      routes.every(
        (route) =>
          (route.Properties as { AuthorizationType?: string }).AuthorizationType === 'NONE',
      ),
    ).toBe(true);

    foundationTemplate.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
      DefaultRouteSettings: {
        ThrottlingBurstLimit: 20,
        ThrottlingRateLimit: 10,
      },
    });

    const encoded = JSON.stringify(foundationTemplate.toJSON());
    expect(encoded).not.toContain('"AllowOrigins":["*"]');
  });

  it('builds bounded observable Node 22 x86_64 Lambdas without reserved concurrency', () => {
    foundationTemplate.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      {
        Architectures: ['x86_64'],
        EphemeralStorage: { Size: 2048 },
        MemorySize: 1024,
        Runtime: 'nodejs22.x',
        Timeout: 30,
        TracingConfig: { Mode: 'Active' },
      },
      2,
    );
    foundationTemplate.resourceCountIs('AWS::Logs::LogGroup', 3);
    foundationTemplate.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
    expect(JSON.stringify(foundationTemplate.findResources('AWS::Lambda::Function'))).not.toContain(
      'ReservedConcurrentExecutions',
    );
  });

  it('packages the local verified release contract and uses one secret dynamic reference', () => {
    const functions = Object.values(
      foundationTemplate.findResources('AWS::Lambda::Function'),
    ).filter((resource) => {
      const variables = (resource.Properties as SynthesizedResource['Properties'])?.Environment
        ?.Variables;
      return variables?.POWERTOOLS_SERVICE_NAME !== undefined;
    });
    expect(functions).toHaveLength(2);
    const environments = functions.map(
      (resource) =>
        (resource.Properties as SynthesizedResource['Properties'])?.Environment?.Variables ?? {},
    );
    for (const environment of environments) {
      expect(environment.ORACLE_RELEASE_ROOT).toBe('/var/task/release');
      expect(environment.ORACLE_SERVING_CONFIG_RELATIVE_PATH).toBe('template-test-only.json');
      expect(environment).not.toHaveProperty('ORACLE_CURSOR_SECRET_ARN');
      expect(environment).not.toHaveProperty('ORACLE_PUBLIC_RELEASE_BUCKET');
      expect(environment).not.toHaveProperty('ORACLE_PUBLIC_RELEASE_PREFIX');
    }
    expect(environments[0]?.ORACLE_CURSOR_HMAC_SECRET_BASE64).toEqual(
      environments[1]?.ORACLE_CURSOR_HMAC_SECRET_BASE64,
    );
    const secretReference = JSON.stringify(environments[0]?.ORACLE_CURSOR_HMAC_SECRET_BASE64);
    expect(secretReference).toContain('resolve:secretsmanager');
    expect(secretReference).toContain('cursorHmacSecretBase64');
    foundationTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: {
        ExcludePunctuation: true,
        GenerateStringKey: 'cursorHmacSecretBase64',
        PasswordLength: 44,
        SecretStringTemplate: '{}',
      },
    });
  });

  it('does not grant product roles obsolete bucket or runtime secret reads', () => {
    const policies = productRolePolicies(foundationTemplate);
    const encoded = JSON.stringify(policies);

    expect(encoded).not.toContain('s3:GetObject');
    expect(encoded).not.toContain('s3:ListBucket');
    expect(encoded).not.toContain('secretsmanager:GetSecretValue');
    expect(encoded).not.toContain('s3:PutObject');
    expect(encoded).not.toContain('s3:DeleteObject');
    expect(encoded).not.toContain('RestrictedArtifactBucket');
  });

  it('adds exact-profile Bedrock permission only with complete promotion evidence', () => {
    const promotion: BedrockPromotion = {
      inferenceProfileArn:
        'arn:aws:bedrock:us-east-2:417242953053:inference-profile/us.oracle-profile-v1',
      invocationResourceArns: [
        'arn:aws:bedrock:us-east-2:417242953053:inference-profile/us.oracle-profile-v1',
        'arn:aws:bedrock:us-east-2::foundation-model/example.model-v1:0',
      ],
      modelId: 'us.oracle-profile-v1',
      region: 'us-east-2',
      semanticPolicyHash: `sha256:${'a'.repeat(64)}`,
    };
    const promotedApp = new cdk.App();
    const promotedStack = new OracleFoundationStack(promotedApp, 'PromotedStack', {
      bedrockPromotion: promotion,
      env: { account: '417242953053', region: 'us-east-2' },
      testOnlyFunctionCodeOverride: templateTestCode,
    });
    const promotedTemplate = Template.fromStack(promotedStack);
    const promotedPolicies = JSON.stringify(productRolePolicies(promotedTemplate));

    expect(promotedPolicies).toContain('bedrock:InvokeModel');
    expect(promotedPolicies).toContain('bedrock:InvokeModelWithResponseStream');
    expect(promotedPolicies).toContain('bedrock:InferenceProfileArn');
    expect(promotedPolicies).toContain(promotion.inferenceProfileArn);
    expect(promotedPolicies).not.toContain('arn:aws:bedrock:*');

    const baseline = JSON.stringify(productRolePolicies(foundationTemplate));
    expect(baseline).not.toContain('bedrock:InvokeModel');
    expect(
      () =>
        new OracleFoundationStack(new cdk.App(), 'InvalidPromotionStack', {
          bedrockPromotion: { ...promotion, invocationResourceArns: ['arn:aws:bedrock:*'] },
          testOnlyFunctionCodeOverride: templateTestCode,
        }),
    ).toThrow('cannot contain wildcards');
  }, 20_000);

  it('runs cheap health-only API destinations with bounded retry, one DLQ, and alarms', () => {
    foundationTemplate.resourceCountIs('AWS::Events::ApiDestination', 2);
    foundationTemplate.resourceCountIs('AWS::Events::Rule', 2);
    foundationTemplate.resourceCountIs('AWS::SQS::Queue', 1);
    foundationTemplate.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true,
    });
    foundationTemplate.resourceCountIs('AWS::CloudWatch::Alarm', 6);
    foundationTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 1,
      Threshold: 0,
      TreatMissingData: 'notBreaching',
    });

    const destinations = JSON.stringify(
      foundationTemplate.findResources('AWS::Events::ApiDestination'),
    );
    expect(destinations).toContain('/health');
    expect(destinations).toContain('/mcp/health');
    expect(destinations).not.toContain('dataset.getInfo');
    expect(destinations).not.toContain('agent.ask');
  });

  it('publishes stable evaluator, API, MCP, artifact, isolation, and alarm outputs', () => {
    const synthesized = foundationTemplate.toJSON() as {
      Outputs?: Record<string, unknown>;
    };
    const outputs = Object.keys(synthesized.Outputs ?? {}).sort();
    expect(outputs).toEqual(
      [
        'ApiUrl',
        'McpUrl',
        'OperationalAlertTopicArn',
        'PublicArtifactUrl',
        'PublicReleaseBucketName',
        'RestrictedArtifactBucketName',
        'WebUrl',
      ].sort(),
    );
  });

  it('does not provision an always-on data service', () => {
    const resources = foundationTemplate.toJSON().Resources as Record<string, { Type?: string }>;
    const prohibited = new Set([
      'AWS::Amplify::App',
      'AWS::DynamoDB::Table',
      'AWS::ECS::Service',
      'AWS::EC2::Instance',
      'AWS::Glue::Database',
      'AWS::Glue::Job',
      'AWS::OpenSearchService::Domain',
      'AWS::RDS::DBCluster',
      'AWS::RDS::DBInstance',
      'AWS::StepFunctions::StateMachine',
    ]);
    expect(
      Object.values(resources).filter((resource) => prohibited.has(resource.Type ?? '')),
    ).toEqual([]);
  });

  it('rejects production synthesis without a caller-selected release', () => {
    expect(
      () =>
        new OracleFoundationStack(new cdk.App(), 'MissingReleaseStack', {
          env: { account: '417242953053', region: 'us-east-2' },
        }),
    ).toThrow('caller-selected Oracle public release directory is required');
  });

  const bundleImportTest = process.env.ORACLE_RUN_LAMBDA_BUNDLE_IMPORT === '1' ? it : it.skip;
  bundleImportTest(
    'packages and imports production-composed x86_64 handlers with Linux DuckDB',
    async () => {
      const outputDirectory = await mkdtemp(join(tmpdir(), 'oracle-lambda-assets-'));

      try {
        execFileSync(process.execPath, [
          '--experimental-strip-types',
          testReleaseGenerator,
          'create',
        ]);
        const assetApp = new cdk.App({ outdir: outputDirectory });
        const assetStack = new OracleFoundationStack(assetApp, 'AssetRegressionStack', {
          env: { account: '417242953053', region: 'us-east-2' },
          publicReleaseDirectory: testReleaseDirectory,
          servingConfigRelativePath: 'serving-config.json',
          testOnlyAllowFixtureRelease: true,
        });
        assetApp.synth();

        const synthesizedTemplate = JSON.parse(
          await readFile(join(outputDirectory, `${assetStack.stackName}.template.json`), 'utf8'),
        ) as SynthesizedTemplate;
        const productFunctions = Object.values(synthesizedTemplate.Resources).filter((resource) => {
          const serviceName = resource.Properties?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME;

          return (
            resource.Type === 'AWS::Lambda::Function' &&
            resource.Properties?.Runtime === 'nodejs22.x' &&
            typeof serviceName === 'string' &&
            serviceName in healthPaths
          );
        });

        expect(productFunctions).toHaveLength(2);

        for (const productFunction of productFunctions) {
          const properties = productFunction.Properties;
          const assetKey = properties?.Code?.S3Key;
          const configuredHandler = properties?.Handler;
          const serviceName = properties?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME;

          expect(properties?.Architectures).toEqual(['x86_64']);
          expect(assetKey).toMatch(/^[a-f\d]{64}\.zip$/u);

          if (
            assetKey === undefined ||
            configuredHandler === undefined ||
            typeof serviceName !== 'string'
          ) {
            throw new Error(
              'Synthesized product Lambda is missing its asset, handler, or service name',
            );
          }
          expect(configuredHandler).toBe(handlers[serviceName]);
          expect(serviceName).toBeOneOf(Object.keys(healthPaths));

          const entryPoint = configuredHandler.slice(0, configuredHandler.lastIndexOf('.'));
          const assetDirectory = join(outputDirectory, `asset.${assetKey.slice(0, -4)}`);
          const assetFiles = await readdir(assetDirectory);
          const bundleFiles = assetFiles.filter((fileName) =>
            [`${entryPoint}.js`, `${entryPoint}.mjs`, `${entryPoint}.cjs`].includes(fileName),
          );

          expect(bundleFiles).toHaveLength(1);

          const bundleFile = bundleFiles[0];
          if (bundleFile === undefined) {
            throw new Error(`Synthesized Lambda asset ${assetKey} has no Node entry point`);
          }

          const healthPath = healthPaths[serviceName];
          if (healthPath === undefined) {
            throw new Error(`Unexpected synthesized service name: ${serviceName}`);
          }
          const assetTree = await recursiveFiles(assetDirectory);
          const nativeBinaries = assetTree.filter((path) => path.endsWith('.node'));
          expect(nativeBinaries.length).toBeGreaterThan(0);
          expect(nativeBinaries.some((path) => path.includes('node-bindings-linux-x64'))).toBe(
            true,
          );
          expect(nativeBinaries.some((path) => /darwin|win32|linux-arm64/iu.test(path))).toBe(
            false,
          );
          expect(assetTree).toContain('release/serving-config.json');
          expect(assetTree).toContain('release/release-manifest.json');

          runLinuxLambdaVerification(assetDirectory, bundleFile, serviceName, healthPath);
        }
      } finally {
        await rm(outputDirectory, { recursive: true, force: true });
        execFileSync(process.execPath, [
          '--experimental-strip-types',
          testReleaseGenerator,
          'remove',
        ]);
      }
    },
    300_000,
  );
});

async function recursiveFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  };
  await visit(root, '');
  return files;
}

function runLinuxLambdaVerification(
  assetDirectory: string,
  bundleFile: string,
  serviceName: string,
  healthPath: string,
): void {
  const script = `
const { randomBytes } = await import('node:crypto');
process.env.ORACLE_CURSOR_HMAC_SECRET_BASE64 = randomBytes(33).toString('base64');
const duckdb = await import('@duckdb/node-api');
const instance = await duckdb.DuckDBInstance.create(':memory:');
const connection = await instance.connect();
const rows = (await connection.runAndReadAll('SELECT 1 AS value')).getRowObjects();
if (Number(rows[0]?.value) !== 1) throw new Error('DuckDB SELECT 1 failed');
connection.closeSync();
instance.closeSync();
const module = await import('file:///var/task/' + process.env.ORACLE_HANDLER_FILE);
if (typeof module.handler !== 'function') throw new Error('Lambda handler export is missing');
const rawPath = process.env.ORACLE_HEALTH_PATH;
const event = ${JSON.stringify(gatewayEvent('/health'))};
event.rawPath = rawPath;
event.routeKey = 'GET ' + rawPath;
event.requestContext.http.path = rawPath;
event.requestContext.routeKey = event.routeKey;
const response = await module.handler(event, {});
if (response.statusCode !== 200) throw new Error('Health returned ' + response.statusCode);
const body = JSON.parse(response.body ?? '{}');
if (body.readiness !== 'ready') {
  throw new Error('Production release was not composed: ' + JSON.stringify(body));
}
if (body.dataQueryPerformed === true || Number(body.dataQueriesExecuted ?? 0) !== 0) {
  throw new Error('Health performed a data query');
}
`;
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--volume',
      `${assetDirectory}:/var/task:ro`,
      '--env',
      'ORACLE_RELEASE_ROOT=/var/task/release',
      '--env',
      'ORACLE_SERVING_CONFIG_RELATIVE_PATH=serving-config.json',
      '--env',
      'ORACLE_ALLOWED_ORIGINS=https://oracle.example.test',
      '--env',
      `ORACLE_HANDLER_FILE=${bundleFile}`,
      '--env',
      `ORACLE_HEALTH_PATH=${healthPath}`,
      '--entrypoint',
      'node',
      'public.ecr.aws/lambda/nodejs:22-x86_64',
      '--input-type=module',
      '--eval',
      script,
    ],
    { stdio: 'pipe', timeout: 120_000 },
  );
  expect(serviceName).toBeOneOf(Object.keys(healthPaths));
}
