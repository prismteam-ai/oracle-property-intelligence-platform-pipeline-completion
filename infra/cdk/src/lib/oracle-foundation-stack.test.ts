import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { describe, expect, it } from 'vitest';

import {
  OracleFoundationStack,
  SAME_ORIGIN_APPLICATION_OPERATIONS,
  type BedrockPromotion,
} from './oracle-foundation-stack.js';

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

interface CloudFrontDistributionConfig {
  CacheBehaviors?: Record<string, unknown>[];
  DefaultCacheBehavior?: Record<string, unknown>;
  DefaultRootObject?: string;
  Origins?: Record<string, unknown>[];
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
const expectedPublicReleaseFiles = [
  'public/data-dictionary.parquet',
  'public/field-coverage.parquet',
  'public/pipeline-runs.parquet',
  'public/property-evidence.parquet',
  'public/property-query.parquet',
  'public/relation-coverage.parquet',
  'public/source-coverage.parquet',
  'release-manifest.json',
  'serving-config.json',
] as const;

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
    expect(Object.values(functions)).toHaveLength(2);
    const functionCode = (
      Object.values(functions).find((resource) =>
        JSON.stringify(resource.Properties).includes('Rewrite only extensionless evaluator'),
      )?.Properties as { FunctionCode?: unknown } | undefined
    )?.FunctionCode;
    const apiEdgeCode = (
      Object.values(functions).find((resource) =>
        JSON.stringify(resource.Properties).includes('Resolve same-origin preflight'),
      )?.Properties as { FunctionCode?: unknown } | undefined
    )?.FunctionCode;
    expect(typeof functionCode).toBe('string');
    expect(typeof apiEdgeCode).toBe('string');
    for (const code of [functionCode, apiEdgeCode]) {
      expect(Buffer.byteLength(String(code), 'utf8')).toBeLessThanOrEqual(10 * 1024);
    }
    const rewrite = (uri: string): string => {
      const context: {
        event: { request: { method: string; uri: string } };
        result?: { uri?: string };
      } = {
        event: { request: { method: 'GET', uri } },
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

    const mcpContext: {
      event: { request: { method: string; uri: string } };
      result?: {
        body?: string;
        headers?: Record<string, { value?: string }>;
        statusCode?: number;
        uri?: string;
      };
    } = { event: { request: { method: 'GET', uri: '/mcp' } } };
    runInNewContext(`${String(apiEdgeCode)}\nresult = handler(event);`, mcpContext);
    expect(mcpContext.result).toMatchObject({
      statusCode: 200,
      headers: {
        'cache-control': { value: 'no-store' },
        'content-type': { value: 'text/html; charset=utf-8' },
        'strict-transport-security': { value: 'max-age=31536000' },
      },
    });
    expect(mcpContext.result?.body).toContain('<div id="root"></div>');
    expect(mcpContext.result?.body).toMatch(/src="\/assets\/index-[^"]+\.js"/u);

    const mcpPostContext: {
      event: { request: { method: string; uri: string } };
      result?: { method?: string; uri?: string };
    } = { event: { request: { method: 'POST', uri: '/mcp' } } };
    runInNewContext(`${String(apiEdgeCode)}\nresult = handler(event);`, mcpPostContext);
    expect(mcpPostContext.result).toEqual({ method: 'POST', uri: '/mcp' });

    const preflight = (headers: Record<string, { value: string }>) => {
      const context: {
        event: {
          request: {
            headers: Record<string, { value: string }>;
            method: string;
            uri: string;
          };
        };
        result?: {
          body?: string;
          headers?: Record<string, { value?: string }>;
          statusCode?: number;
        };
      } = {
        event: { request: { headers, method: 'OPTIONS', uri: '/dataset.getInfo' } },
      };
      runInNewContext(`${String(apiEdgeCode)}\nresult = handler(event);`, context);
      return context.result;
    };
    const sameOriginPreflight = preflight({
      'access-control-request-headers': { value: 'Content-Type, X-Request-ID' },
      'access-control-request-method': { value: 'POST' },
      host: { value: 'd111111abcdef8.cloudfront.net' },
      origin: { value: 'https://d111111abcdef8.cloudfront.net' },
    });
    expect(sameOriginPreflight).toMatchObject({
      statusCode: 204,
      headers: {
        'access-control-allow-headers': {
          value: 'authorization,content-type,x-request-id',
        },
        'access-control-allow-methods': { value: 'GET,POST,OPTIONS' },
        'access-control-allow-origin': {
          value: 'https://d111111abcdef8.cloudfront.net',
        },
        'access-control-max-age': { value: '600' },
        'strict-transport-security': { value: 'max-age=31536000' },
        'x-content-type-options': { value: 'nosniff' },
      },
    });
    expect(sameOriginPreflight).not.toHaveProperty('body');
    for (const rejected of [
      preflight({
        'access-control-request-method': { value: 'POST' },
        host: { value: 'd111111abcdef8.cloudfront.net' },
        origin: { value: 'https://attacker.test' },
      }),
      preflight({
        'access-control-request-method': { value: 'DELETE' },
        host: { value: 'd111111abcdef8.cloudfront.net' },
        origin: { value: 'https://d111111abcdef8.cloudfront.net' },
      }),
      preflight({
        'access-control-request-headers': { value: 'x-unbounded-header' },
        'access-control-request-method': { value: 'POST' },
        host: { value: 'd111111abcdef8.cloudfront.net' },
        origin: { value: 'https://d111111abcdef8.cloudfront.net' },
      }),
    ]) {
      expect(rejected).toMatchObject({
        statusCode: 403,
        headers: {
          'strict-transport-security': { value: 'max-age=31536000' },
          'x-content-type-options': { value: 'nosniff' },
        },
      });
      expect(rejected).not.toHaveProperty('body');
      expect(rejected?.headers).not.toHaveProperty('access-control-allow-origin');
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

  it('routes only the current same-origin API contract to the uncached HTTP API origin', async () => {
    const contractSource = await readFile(
      resolve(repositoryRoot, 'apps/api/src/contract.ts'),
      'utf8',
    );
    const operationBlock = /export const applicationOperations = \[([\s\S]*?)\] as const;/u.exec(
      contractSource,
    )?.[1];
    if (operationBlock === undefined) {
      throw new Error('The application operation inventory could not be read from its contract.');
    }
    const applicationOperations = [...operationBlock.matchAll(/'([^']+)'/gu)].map(
      (match) => match[1],
    );
    expect(
      operationBlock
        .replace(/'[^']+'/gu, '')
        .replaceAll(',', '')
        .trim(),
    ).toBe('');
    expect(new Set(applicationOperations).size).toBe(applicationOperations.length);

    const webTypesSource = await readFile(resolve(repositoryRoot, 'apps/web/src/types.ts'), 'utf8');
    const webOperationBlock = /export type ApplicationOperation =([\s\S]*?);/u.exec(
      webTypesSource,
    )?.[1];
    if (webOperationBlock === undefined) {
      throw new Error('The browser operation inventory could not be read from its type contract.');
    }
    const browserOperations = [...webOperationBlock.matchAll(/\|\s*'([^']+)'/gu)].map(
      (match) => match[1],
    );
    expect(webOperationBlock.replace(/\|\s*'[^']+'/gu, '').trim()).toBe('');
    expect(new Set(browserOperations).size).toBe(browserOperations.length);
    expect(browserOperations).toEqual(applicationOperations);
    expect(SAME_ORIGIN_APPLICATION_OPERATIONS).toEqual(applicationOperations);
    expect(SAME_ORIGIN_APPLICATION_OPERATIONS).toEqual(browserOperations);

    const distributions = Object.values(
      foundationTemplate.findResources('AWS::CloudFront::Distribution'),
    );
    const webDistribution = distributions.find((resource) => {
      const config = (resource.Properties as { DistributionConfig?: CloudFrontDistributionConfig })
        .DistributionConfig;
      return config?.DefaultRootObject === 'index.html';
    });
    expect(webDistribution).toBeDefined();
    const config = (
      webDistribution?.Properties as { DistributionConfig?: CloudFrontDistributionConfig }
    ).DistributionConfig;
    if (config === undefined) throw new Error('Web distribution config was not synthesized.');

    const behaviors = config.CacheBehaviors ?? [];
    const expectedPatterns = [
      'health',
      'mcp',
      'mcp/health',
      'trpc/*',
      ...applicationOperations,
    ].sort();
    expect(behaviors.map((behavior) => String(behavior.PathPattern)).sort()).toEqual(
      expectedPatterns,
    );
    expect(expectedPatterns).not.toContain('*.*');
    expect(expectedPatterns).not.toContain('*');

    const apiOriginId = behaviors[0]?.TargetOriginId;
    expect(typeof apiOriginId).toBe('string');
    for (const behavior of behaviors) {
      expect(behavior).toMatchObject({
        AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
        CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
        Compress: false,
        OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
        ResponseHeadersPolicyId: '67f7725c-6f97-4210-82d7-5512b31e9d03',
        TargetOriginId: apiOriginId,
        ViewerProtocolPolicy: 'redirect-to-https',
      });
    }

    expect(config.DefaultCacheBehavior).toMatchObject({
      AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
      CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
      Compress: true,
      ViewerProtocolPolicy: 'redirect-to-https',
    });
    expect(config.DefaultCacheBehavior?.TargetOriginId).not.toBe(apiOriginId);
    expect(config.Origins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Id: config.DefaultCacheBehavior?.TargetOriginId }),
        expect.objectContaining({
          CustomOriginConfig: expect.objectContaining({ OriginProtocolPolicy: 'https-only' }),
          Id: apiOriginId,
        }),
      ]),
    );
    expect(JSON.stringify(config.Origins)).toContain('HttpApi');
    expect(JSON.stringify(config.DefaultCacheBehavior)).toContain('SpaRewrite');
    for (const behavior of behaviors) {
      expect(JSON.stringify(behavior)).toContain('ApiEdgeRequest');
      expect(JSON.stringify(behavior)).not.toContain('SpaRewrite');
    }
  });

  it('promotes only the validator-returned nine-file release root with retained explicit invalidation', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'oracle-release-assets-'));

    try {
      execFileSync(process.execPath, [
        '--experimental-strip-types',
        testReleaseGenerator,
        'create',
      ]);
      const releaseApp = new cdk.App({ outdir: outputDirectory });
      const releaseStack = new OracleFoundationStack(releaseApp, 'ReleasePromotionStack', {
        env: { account: '417242953053', region: 'us-east-2' },
        publicReleaseDirectory: testReleaseDirectory,
        servingConfigRelativePath: 'serving-config.json',
        testOnlyAllowFixtureRelease: true,
        testOnlyFunctionCodeOverride: templateTestCode,
      });
      const releaseTemplate = Template.fromStack(releaseStack);
      const releaseDeployment = releaseStack.node.findChild('PublicReleaseDeployment');
      const releaseAsset = releaseDeployment.node.findChild('Asset1') as s3assets.Asset;
      const releaseAssetStage = releaseAsset.node.findChild('Stage') as cdk.AssetStaging;

      expect(await realpath(releaseAssetStage.sourcePath)).toBe(
        await realpath(testReleaseDirectory),
      );
      expect([...(await recursiveFiles(releaseAssetStage.sourcePath))].sort()).toEqual(
        expectedPublicReleaseFiles,
      );

      const deployments = releaseTemplate.findResources('Custom::CDKBucketDeployment');
      expect(Object.keys(deployments)).toHaveLength(2);
      const releaseDeploymentEntry = Object.entries(deployments).find(([logicalId]) =>
        logicalId.startsWith('PublicReleaseDeployment'),
      );
      expect(releaseDeploymentEntry).toBeDefined();
      const releaseDeploymentProperties = releaseDeploymentEntry?.[1].Properties as
        Record<string, unknown> | undefined;
      expect(releaseDeploymentProperties).toMatchObject({
        DestinationBucketName: { Ref: expect.stringContaining('PublicReleaseBucket') },
        DistributionId: { Ref: expect.stringContaining('ArtifactDistribution') },
        DistributionPaths: ['/*'],
        Prune: false,
        RetainOnDelete: true,
        WaitForDistributionInvalidation: true,
      });
      expect(releaseDeploymentProperties).not.toHaveProperty('DestinationBucketKeyPrefix');
      expect(JSON.stringify(releaseDeploymentProperties)).not.toContain('WebBucket');
      expect(JSON.stringify(releaseDeploymentProperties)).not.toContain('RestrictedArtifactBucket');
      expect(JSON.stringify(releaseTemplate.findResources('AWS::IAM::Policy'))).not.toContain(
        's3:PutObjectAcl',
      );
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
      execFileSync(process.execPath, [
        '--experimental-strip-types',
        testReleaseGenerator,
        'remove',
      ]);
    }
  });

  it('exposes only committed API and MCP routes while preflight terminates at CloudFront', () => {
    foundationTemplate.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    foundationTemplate.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
    });
    const apis = foundationTemplate.findResources('AWS::ApiGatewayV2::Api');
    expect(Object.values(apis)[0]?.Properties).not.toHaveProperty('CorsConfiguration');

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
    expect(JSON.stringify(routes)).not.toContain('OPTIONS');

    foundationTemplate.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
      DefaultRouteSettings: {
        ThrottlingBurstLimit: 20,
        ThrottlingRateLimit: 10,
      },
    });

    const encoded = JSON.stringify(foundationTemplate.toJSON());
    expect(encoded).not.toContain('"AllowOrigins":["*"]');
    expect(encoded).not.toContain('CorsConfiguration');
    const apiFunction = Object.values(
      foundationTemplate.findResources('AWS::Lambda::Function'),
    ).find((resource) => {
      const variables = (resource.Properties as SynthesizedResource['Properties'])?.Environment
        ?.Variables;
      return variables?.POWERTOOLS_SERVICE_NAME === 'oracle-application-api';
    });
    const allowedOrigins = (apiFunction?.Properties as SynthesizedResource['Properties'])
      ?.Environment?.Variables?.ORACLE_ALLOWED_ORIGINS;
    expect(JSON.stringify(allowedOrigins)).toContain('WebDistribution');
    expect(JSON.stringify(allowedOrigins)).not.toContain('*');
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

  it('rejects an invalid selected release before creating any asset', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'oracle-invalid-release-'));
    const invalidApp = new cdk.App({ outdir: outputDirectory });

    try {
      expect(
        () =>
          new OracleFoundationStack(invalidApp, 'InvalidReleaseStack', {
            env: { account: '417242953053', region: 'us-east-2' },
            publicReleaseDirectory: 'infra/cdk/test-fixtures/does-not-exist',
            servingConfigRelativePath: 'serving-config.json',
            testOnlyFunctionCodeOverride: templateTestCode,
          }),
      ).toThrow('public release directory does not exist');
      expect(
        invalidApp.node.findAll().filter((construct) => construct instanceof cdk.AssetStaging),
      ).toEqual([]);
      expect(await readdir(outputDirectory)).toEqual([]);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
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
