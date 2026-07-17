import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { OracleFoundationStack } from './oracle-foundation-stack.js';

const app = new cdk.App();
const stack = new OracleFoundationStack(app, 'TestStack', {
  env: { account: '417242953053', region: 'us-east-2' },
});
const foundationTemplate = Template.fromStack(stack);

interface SynthesizedResource {
  Type?: string;
  Properties?: {
    Code?: { S3Key?: string };
    Environment?: { Variables?: Record<string, string> };
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

type LambdaHandler = (event: GatewayEvent, context: Record<string, never>) => unknown;

const healthPaths: Record<string, string> = {
  'oracle-foundation-api': '/health',
  'oracle-foundation-mcp': '/mcp/health',
};

function gatewayEvent(rawPath: string): GatewayEvent {
  const routeKey = 'GET /{proxy+}';

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

describe('Oracle foundation infrastructure', () => {
  it('provides private OAC-backed SPA hosting', () => {
    foundationTemplate.resourceCountIs('AWS::S3::Bucket', 1);
    foundationTemplate.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    foundationTemplate.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    foundationTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
      },
    });
  });

  it('provides a HTTP API and two observable Node 22 Lambdas', () => {
    foundationTemplate.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    foundationTemplate.resourceCountIs('AWS::Lambda::Function', 3);
    foundationTemplate.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      {
        Runtime: 'nodejs22.x',
        TracingConfig: { Mode: 'Active' },
      },
      2,
    );
    foundationTemplate.resourceCountIs('AWS::Logs::LogGroup', 2);
    foundationTemplate.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
  });

  it('does not provision Amplify or premature business-data services', () => {
    const resources = foundationTemplate.toJSON().Resources as Record<string, { Type?: string }>;
    const prohibited = new Set([
      'AWS::Amplify::App',
      'AWS::DynamoDB::Table',
      'AWS::RDS::DBCluster',
      'AWS::RDS::DBInstance',
      'AWS::OpenSearchService::Domain',
      'AWS::SQS::Queue',
      'AWS::StepFunctions::StateMachine',
      'AWS::Glue::Database',
      'AWS::Glue::Job',
    ]);
    expect(
      Object.values(resources).filter((resource) => prohibited.has(resource.Type ?? '')),
    ).toEqual([]);
  });

  it('synthesizes executable API and MCP Lambda assets with healthy handlers', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'oracle-lambda-assets-'));

    try {
      const assetApp = new cdk.App({ outdir: outputDirectory });
      const assetStack = new OracleFoundationStack(assetApp, 'AssetRegressionStack', {
        env: { account: '417242953053', region: 'us-east-2' },
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
          serviceName !== undefined &&
          serviceName in healthPaths
        );
      });

      expect(productFunctions).toHaveLength(2);

      for (const productFunction of productFunctions) {
        const properties = productFunction.Properties;
        const assetKey = properties?.Code?.S3Key;
        const configuredHandler = properties?.Handler;
        const serviceName = properties?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME;

        expect(assetKey).toMatch(/^[a-f\d]{64}\.zip$/u);
        expect(configuredHandler).toBe('index.handler');
        expect(serviceName).toBeOneOf(Object.keys(healthPaths));

        if (
          assetKey === undefined ||
          configuredHandler === undefined ||
          serviceName === undefined
        ) {
          throw new Error(
            'Synthesized product Lambda is missing its asset, handler, or service name',
          );
        }

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

        const bundleUrl = pathToFileURL(join(assetDirectory, bundleFile));
        bundleUrl.searchParams.set('asset', assetKey);
        const bundle = (await import(/* @vite-ignore */ bundleUrl.href)) as {
          handler?: LambdaHandler;
        };

        expect(bundle.handler).toBeTypeOf('function');
        if (bundle.handler === undefined) {
          throw new Error(`Synthesized Lambda asset ${assetKey} has no handler export`);
        }

        const healthPath = healthPaths[serviceName];
        if (healthPath === undefined) {
          throw new Error(`Unexpected synthesized service name: ${serviceName}`);
        }

        const response = await bundle.handler(gatewayEvent(healthPath), {});
        expect(response).toMatchObject({
          statusCode: 200,
        });
      }
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
