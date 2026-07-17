import { resolve } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const PROJECT = 'oracle-property-intelligence-platform';
const REPOSITORY = 'oracle-property-intelligence-platform-pipeline-completion';

export class OracleFoundationStack extends cdk.Stack {
  public constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('project', PROJECT);
    cdk.Tags.of(this).add('project_name', PROJECT);
    cdk.Tags.of(this).add('repository', REPOSITORY);

    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
    });

    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: cdk.Duration.seconds(0),
      })),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    new s3deploy.BucketDeployment(this, 'WebDeployment', {
      sources: [s3deploy.Source.asset(resolve(import.meta.dirname, '../../../../apps/web/dist'))],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    const apiFunction = this.createFunction(
      'ApiFunction',
      'oracle-foundation-api',
      resolve(import.meta.dirname, '../../../../apps/api/src/handler.ts'),
    );
    const mcpFunction = this.createFunction(
      'McpFunction',
      'oracle-foundation-mcp',
      resolve(import.meta.dirname, '../../../../apps/mcp/src/handler.ts'),
    );

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${PROJECT}-api`,
      corsPreflight: {
        allowHeaders: ['content-type'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowOrigins: ['*'],
      },
    });

    const apiIntegration = new integrations.HttpLambdaIntegration('ApiIntegration', apiFunction);
    const mcpIntegration = new integrations.HttpLambdaIntegration('McpIntegration', mcpFunction);

    httpApi.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.ANY],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: '/mcp',
      methods: [apigwv2.HttpMethod.ANY],
      integration: mcpIntegration,
    });
    httpApi.addRoutes({
      path: '/mcp/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: mcpIntegration,
    });

    new cdk.CfnOutput(this, 'WebUrl', {
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
  }

  private createFunction(id: string, serviceName: string, entry: string): nodejs.NodejsFunction {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    return new nodejs.NodejsFunction(this, id, {
      entry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_LOG_LEVEL: 'INFO',
        POWERTOOLS_SERVICE_NAME: serviceName,
      },
      bundling: {
        format: nodejs.OutputFormat.CJS,
        mainFields: ['module', 'main'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });
  }
}
