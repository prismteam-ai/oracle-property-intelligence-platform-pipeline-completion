import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { OracleFoundationStack } from './oracle-foundation-stack.js';

const app = new cdk.App();
const stack = new OracleFoundationStack(app, 'TestStack', {
  env: { account: '417242953053', region: 'us-east-2' },
});
const foundationTemplate = Template.fromStack(stack);

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
});
