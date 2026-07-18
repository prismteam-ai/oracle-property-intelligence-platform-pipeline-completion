import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

import { validatePublicReleaseBundle, type VerifiedPublicRelease } from './public-release.js';

const PROJECT = 'oracle-property-intelligence-platform';
const REPOSITORY = 'oracle-property-intelligence-platform-pipeline-completion';
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../../');
const CURSOR_SECRET_JSON_KEY = 'cursorHmacSecretBase64';
const WEB_INDEX_PATH = resolve(REPOSITORY_ROOT, 'apps/web/dist/index.html');

export const SAME_ORIGIN_APPLICATION_OPERATIONS = [
  'dataset.getInfo',
  'dataset.getCoverage',
  'pipeline.listRuns',
  'pipeline.getRun',
  'property.search',
  'property.get',
  'property.getEvidence',
  'inquiry.roofAge',
  'inquiry.waterCandidates',
  'inquiry.ownershipAge',
  'inquiry.regionalOwner',
  'inquiry.transitWalkability',
  'inquiry.starbucksWalkability',
  'inquiry.rankCandidates',
  'artifacts.list',
  'artifacts.getDataDictionary',
  'agent.ask',
  'agent.status',
] as const;

const SAME_ORIGIN_API_PATH_PATTERNS = [
  'health',
  'mcp',
  'mcp/health',
  'trpc/*',
  ...SAME_ORIGIN_APPLICATION_OPERATIONS,
] as const;

export type BedrockPromotion = Readonly<{
  inferenceProfileArn: string;
  invocationResourceArns: readonly string[];
  modelId: string;
  region: 'us-east-1' | 'us-east-2';
  semanticPolicyHash: string;
}>;

export interface OracleFoundationStackProps extends cdk.StackProps {
  bedrockPromotion?: BedrockPromotion;
  publicReleaseDirectory?: string;
  servingConfigRelativePath?: string;
  /** Template-test seam only. The production app never supplies a code override. */
  testOnlyFunctionCodeOverride?: lambda.Code;
  /** Packaging-test seam only. The production app never permits CDK fixture releases. */
  testOnlyAllowFixtureRelease?: boolean;
}

export class OracleFoundationStack extends cdk.Stack {
  public constructor(scope: Construct, id: string, props: OracleFoundationStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('project', PROJECT);
    cdk.Tags.of(this).add('project_name', PROJECT);
    cdk.Tags.of(this).add('repository', REPOSITORY);

    this.validateBedrockPromotion(props.bedrockPromotion);
    const hasReleaseSelection =
      props.publicReleaseDirectory !== undefined || props.servingConfigRelativePath !== undefined;
    const verifiedRelease =
      props.testOnlyFunctionCodeOverride === undefined || hasReleaseSelection
        ? validatePublicReleaseBundle({
            repositoryRoot: REPOSITORY_ROOT,
            releaseDirectory: props.publicReleaseDirectory,
            servingConfigRelativePath: props.servingConfigRelativePath,
            allowTestFixture: props.testOnlyAllowFixtureRelease,
          })
        : undefined;

    const webBucket = this.immutableBucket('WebBucket', cdk.Duration.days(7));
    const releaseBucket = this.immutableBucket('PublicReleaseBucket', cdk.Duration.days(30));
    const restrictedBucket = this.immutableBucket(
      'RestrictedArtifactBucket',
      cdk.Duration.days(30),
    );

    // Keep the API resource independent of the distribution. API integrations
    // are attached after the distribution so the Lambda can receive the exact
    // generated web origin without creating a CloudFormation API <->
    // distribution dependency cycle. Browser preflight terminates at the edge.
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${PROJECT}-api`,
    });
    const apiOrigin = new origins.HttpOrigin(
      cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint)),
      { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY },
    );

    const webIndexDocument = readFileSync(WEB_INDEX_PATH, 'utf8');
    if (Buffer.byteLength(webIndexDocument, 'utf8') > 8 * 1024) {
      throw new Error('The evaluator index exceeds the bounded CloudFront Function response.');
    }

    const apiEdgeRequest = new cloudfront.Function(this, 'ApiEdgeRequest', {
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  if (request.method === 'OPTIONS') {
    var headers = request.headers;
    var host = headers.host && headers.host.value;
    var origin = headers.origin && headers.origin.value;
    var requestedMethod =
      headers['access-control-request-method'] &&
      headers['access-control-request-method'].value;
    var requestedHeaders =
      headers['access-control-request-headers'] &&
      headers['access-control-request-headers'].value;
    var allowedHeaders = ['authorization', 'content-type', 'x-request-id'];
    var requested = requestedHeaders ? requestedHeaders.toLowerCase().split(',') : [];
    var headersAllowed = true;
    for (var h = 0; h < requested.length; h += 1) {
      if (allowedHeaders.indexOf(requested[h].trim()) === -1) headersAllowed = false;
    }
    var securityHeaders = {
      'referrer-policy': { value: 'strict-origin-when-cross-origin' },
      'strict-transport-security': { value: 'max-age=31536000' },
      'x-content-type-options': { value: 'nosniff' },
      'x-frame-options': { value: 'SAMEORIGIN' },
      'x-xss-protection': { value: '1; mode=block' }
    };
    if (!host || origin !== 'https://' + host || requestedMethod !== 'POST' || !headersAllowed) {
      return {
        statusCode: 403,
        statusDescription: 'Forbidden',
        headers: securityHeaders
      };
    }
    securityHeaders['access-control-allow-origin'] = { value: origin };
    securityHeaders['access-control-allow-methods'] = { value: 'GET,POST,OPTIONS' };
    securityHeaders['access-control-allow-headers'] = {
      value: 'authorization,content-type,x-request-id'
    };
    securityHeaders['access-control-max-age'] = { value: '600' };
    securityHeaders.vary = { value: 'origin' };
    return {
      statusCode: 204,
      statusDescription: 'No Content',
      headers: securityHeaders
    };
  }
  if (request.uri === '/mcp' && request.method === 'GET') {
    return {
      statusCode: 200,
      statusDescription: 'OK',
      headers: {
        'cache-control': { value: 'no-store' },
        'content-type': { value: 'text/html; charset=utf-8' },
        'referrer-policy': { value: 'strict-origin-when-cross-origin' },
        'strict-transport-security': { value: 'max-age=31536000' },
        'x-content-type-options': { value: 'nosniff' },
        'x-frame-options': { value: 'SAMEORIGIN' },
        'x-xss-protection': { value: '1; mode=block' }
      },
      body: ${JSON.stringify(webIndexDocument)}
    };
  }
  return request;
}`),
      comment: 'Resolve same-origin preflight and the GET /mcp route collision at the edge.',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var blockedPrefixes = ['/api', '/mcp', '/assets', '/trpc', '/health'];
  for (var i = 0; i < blockedPrefixes.length; i += 1) {
    var prefix = blockedPrefixes[i];
    if (uri === prefix || uri.indexOf(prefix + '/') === 0) return request;
  }
  var firstSegment = uri.substring(1).split('/')[0];
  var blockedOperationNamespaces = [
    'dataset.',
    'pipeline.',
    'property.',
    'inquiry.',
    'artifacts.',
    'agent.'
  ];
  for (var j = 0; j < blockedOperationNamespaces.length; j += 1) {
    if (firstSegment.indexOf(blockedOperationNamespaces[j]) === 0) return request;
  }
  var segment = uri.substring(uri.lastIndexOf('/') + 1);
  if (segment.indexOf('.') !== -1) return request;
  request.uri = '/index.html';
  return request;
}`),
      comment: 'Rewrite only extensionless evaluator SPA deep links.',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });
    const apiBehavior = this.apiCloudFrontBehavior(apiOrigin);
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      additionalBehaviors: Object.fromEntries(
        SAME_ORIGIN_API_PATH_PATTERNS.map((pathPattern) => [
          pathPattern,
          {
            ...apiBehavior,
            functionAssociations: [
              {
                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                function: apiEdgeRequest,
              },
            ],
          },
        ]),
      ),
      defaultBehavior: this.cloudFrontBehavior(
        origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: spaRewrite,
          },
        ],
      ),
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const webOrigin = `https://${distribution.distributionDomainName}`;
    const artifactHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ArtifactHeaders', {
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['range'],
        accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
        accessControlAllowOrigins: [webOrigin],
        accessControlExposeHeaders: ['content-length', 'content-range', 'etag'],
        accessControlMaxAge: cdk.Duration.hours(1),
        originOverride: true,
      },
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
          preload: true,
        },
      },
    });
    const artifactDistribution = new cloudfront.Distribution(this, 'ArtifactDistribution', {
      defaultBehavior: this.cloudFrontBehavior(
        origins.S3BucketOrigin.withOriginAccessControl(releaseBucket),
        artifactHeaders,
      ),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    new s3deploy.BucketDeployment(this, 'WebDeployment', {
      sources: [s3deploy.Source.asset(resolve(import.meta.dirname, '../../../../apps/web/dist'))],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: false,
      retainOnDelete: true,
    });

    if (verifiedRelease !== undefined) {
      new s3deploy.BucketDeployment(this, 'PublicReleaseDeployment', {
        sources: [s3deploy.Source.asset(verifiedRelease.directory)],
        destinationBucket: releaseBucket,
        distribution: artifactDistribution,
        distributionPaths: ['/*'],
        waitForDistributionInvalidation: true,
        prune: false,
        retainOnDelete: true,
      });
    }

    const cursorSecret = new secretsmanager.Secret(this, 'CursorSecret', {
      description: 'Stable HMAC secret for release- and operation-bound Oracle cursors.',
      generateSecretString: {
        generateStringKey: CURSOR_SECRET_JSON_KEY,
        secretStringTemplate: '{}',
        excludePunctuation: true,
        passwordLength: 44,
      },
    });
    const cursorSecretDynamicReference = cursorSecret
      .secretValueFromJson(CURSOR_SECRET_JSON_KEY)
      .toString();

    const sharedEnvironment = {
      NODE_OPTIONS: '--enable-source-maps',
      ORACLE_CURSOR_HMAC_SECRET_BASE64: cursorSecretDynamicReference,
      ORACLE_RELEASE_ROOT: '/var/task/release',
      ORACLE_SERVING_CONFIG_RELATIVE_PATH:
        verifiedRelease?.servingConfigRelativePath ?? 'template-test-only.json',
      POWERTOOLS_LOG_LEVEL: 'INFO',
      POWERTOOLS_METRICS_NAMESPACE: 'OracleFoundation',
    };
    const productCode =
      verifiedRelease === undefined ? undefined : this.createProductCode(verifiedRelease);

    const apiFunction = this.createFunction(
      'ApiFunction',
      'oracle-application-api',
      'api.handler',
      {
        ...sharedEnvironment,
        ORACLE_ALLOWED_ORIGINS: webOrigin,
        POWERTOOLS_SERVICE_NAME: 'oracle-application-api',
        ...this.bedrockEnvironment(props.bedrockPromotion),
      },
      props.testOnlyFunctionCodeOverride,
      productCode,
    );
    const mcpFunction = this.createFunction(
      'McpFunction',
      'oracle-named-evidence-mcp',
      'mcp.handler',
      {
        ...sharedEnvironment,
        POWERTOOLS_SERVICE_NAME: 'oracle-named-evidence-mcp',
      },
      props.testOnlyFunctionCodeOverride,
      productCode,
    );

    this.grantBedrockInvoke(apiFunction, props.bedrockPromotion);

    const apiIntegration = new integrations.HttpLambdaIntegration('ApiIntegration', apiFunction);
    const mcpIntegration = new integrations.HttpLambdaIntegration('McpIntegration', mcpFunction);

    httpApi.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: '/{operation}',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: '/trpc/{operation}',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: '/mcp',
      methods: [apigwv2.HttpMethod.POST],
      integration: mcpIntegration,
    });
    httpApi.addRoutes({
      path: '/mcp/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: mcpIntegration,
    });

    this.configureApiStage(httpApi);

    const alertTopic = new sns.Topic(this, 'OperationalAlerts', {
      displayName: 'Oracle product runtime alarms',
    });
    this.addHttpApiAlarm(httpApi, alertTopic);
    this.addFunctionAlarms(apiFunction, 'ApplicationApi', alertTopic);
    this.addFunctionAlarms(mcpFunction, 'NamedEvidenceMcp', alertTopic);
    this.addHealthCanaries(httpApi.apiEndpoint, alertTopic);

    new cdk.CfnOutput(this, 'WebUrl', {
      description: 'Stable evaluator URL. CloudFront preserves SPA deep links.',
      value: webOrigin,
    });
    new cdk.CfnOutput(this, 'ApiUrl', {
      description: 'Application API base URL.',
      value: httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, 'McpUrl', {
      description: 'Named-evidence Streamable HTTP MCP endpoint.',
      value: `${httpApi.apiEndpoint}/mcp`,
    });
    new cdk.CfnOutput(this, 'PublicArtifactUrl', {
      description: 'Dedicated CloudFront origin for immutable public release artifacts.',
      value: `https://${artifactDistribution.distributionDomainName}/`,
    });
    new cdk.CfnOutput(this, 'PublicReleaseBucketName', {
      description: 'Private origin bucket containing public-class immutable release objects.',
      value: releaseBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'RestrictedArtifactBucketName', {
      description: 'Isolated restricted-artifact bucket; public runtimes receive no access.',
      value: restrictedBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'OperationalAlertTopicArn', {
      description: 'Subscribe approved production on-call channels before deployment.',
      value: alertTopic.topicArn,
    });
  }

  private immutableBucket(id: string, retention: cdk.Duration): s3.Bucket {
    return new s3.Bucket(this, id, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(retention),
      objectLockEnabled: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
    });
  }

  private cloudFrontBehavior(
    origin: cloudfront.IOrigin,
    responseHeadersPolicy = cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
    functionAssociations?: cloudfront.FunctionAssociation[],
  ): cloudfront.BehaviorOptions {
    return {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      compress: true,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy,
      functionAssociations,
    };
  }

  private apiCloudFrontBehavior(origin: cloudfront.IOrigin): cloudfront.BehaviorOptions {
    return {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      compress: false,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
    };
  }

  private createFunction(
    id: string,
    serviceName: string,
    productionHandler: string,
    environment: Record<string, string>,
    testOnlyCodeOverride: lambda.Code | undefined,
    productCode: lambda.Code | undefined,
  ): lambda.Function {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      memorySize: 1024,
      ephemeralStorageSize: cdk.Size.gibibytes(2),
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment,
      description: `${serviceName} (${REPOSITORY})`,
    } as const;

    const code = testOnlyCodeOverride ?? productCode;
    if (code === undefined) {
      throw new Error('A verified public release is required for production Lambda assets.');
    }
    return new lambda.Function(this, id, {
      ...common,
      code,
      handler: testOnlyCodeOverride === undefined ? productionHandler : 'index.handler',
    });
  }

  private createProductCode(verifiedRelease: VerifiedPublicRelease): lambda.Code {
    return lambda.Code.fromAsset(REPOSITORY_ROOT, {
      assetHashType: cdk.AssetHashType.OUTPUT,
      bundling: {
        command: [
          'bash',
          '/asset-input/infra/cdk/docker/lambda-bundler/bundle.sh',
          verifiedRelease.repositoryRelativeDirectory,
        ],
        image: cdk.DockerImage.fromBuild(
          resolve(import.meta.dirname, '../../docker/lambda-bundler'),
          { platform: 'linux/amd64' },
        ),
        platform: 'linux/amd64',
      },
      exclude: ['.git/**', '**/.turbo/**', '**/cdk.out/**', '**/dist/**', '**/node_modules/**'],
      ignoreMode: cdk.IgnoreMode.GLOB,
    });
  }

  private bedrockEnvironment(promotion: BedrockPromotion | undefined): Record<string, string> {
    if (promotion === undefined) return {};
    return {
      ORACLE_AGENT_POLICY_HASH: promotion.semanticPolicyHash,
      ORACLE_BEDROCK_MODEL_ID: promotion.modelId,
      ORACLE_BEDROCK_REGION: promotion.region,
      ORACLE_MODEL_PROVIDER: 'amazon-bedrock',
    };
  }

  private grantBedrockInvoke(
    apiFunction: lambda.Function,
    promotion: BedrockPromotion | undefined,
  ): void {
    if (promotion === undefined) return;
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [...promotion.invocationResourceArns],
        conditions: {
          StringEquals: {
            'bedrock:InferenceProfileArn': promotion.inferenceProfileArn,
          },
        },
      }),
    );
  }

  private validateBedrockPromotion(promotion: BedrockPromotion | undefined): void {
    if (promotion === undefined) return;
    if (
      !/^arn:aws:bedrock:(us-east-1|us-east-2):\d{12}:inference-profile\/.+/u.test(
        promotion.inferenceProfileArn,
      )
    ) {
      throw new Error('Bedrock promotion requires an exact us-east-1/us-east-2 profile ARN.');
    }
    if (
      promotion.invocationResourceArns.length === 0 ||
      promotion.invocationResourceArns.some((resource) => !resource.startsWith('arn:aws:bedrock:'))
    ) {
      throw new Error('Bedrock promotion requires explicit invocation resource ARNs.');
    }
    if (promotion.invocationResourceArns.some((resource) => resource.includes('*'))) {
      throw new Error('Bedrock invocation resources cannot contain wildcards.');
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(promotion.semanticPolicyHash)) {
      throw new Error('Bedrock promotion requires the exact sha256 semantic policy hash.');
    }
  }

  private configureApiStage(httpApi: apigwv2.HttpApi): void {
    const accessLogs = new logs.LogGroup(this, 'HttpApiAccessLogs', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const stage = httpApi.defaultStage?.node.defaultChild;
    if (!(stage instanceof apigwv2.CfnStage)) {
      throw new Error('The HTTP API default stage was not synthesized.');
    }
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        apiId: '$context.apiId',
        integrationError: '$context.integrationErrorMessage',
        integrationLatency: '$context.integrationLatency',
        method: '$context.httpMethod',
        requestId: '$context.requestId',
        routeKey: '$context.routeKey',
        status: '$context.status',
      }),
    };
    stage.defaultRouteSettings = {
      throttlingBurstLimit: 20,
      throttlingRateLimit: 10,
    };
  }

  private addFunctionAlarms(
    productFunction: lambda.Function,
    idPrefix: string,
    alertTopic: sns.Topic,
  ): void {
    const alarm = new cloudwatch.Alarm(this, `${idPrefix}Errors`, {
      alarmDescription: `${idPrefix} returned one or more unhandled Lambda errors.`,
      metric: productFunction.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
    alarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));
  }

  private addHttpApiAlarm(httpApi: apigwv2.HttpApi, alertTopic: sns.Topic): void {
    const alarm = new cloudwatch.Alarm(this, 'HttpApiServerErrors', {
      alarmDescription: 'The public HTTP API returned one or more 5xx responses.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: { ApiId: httpApi.apiId },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
    alarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));
  }

  private addHealthCanaries(apiEndpoint: string, alertTopic: sns.Topic): void {
    const canaryDlq = new sqs.Queue(this, 'HealthCanaryDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const connection = new events.Connection(this, 'HealthCanaryConnection', {
      authorization: events.Authorization.apiKey(
        'x-oracle-health-canary',
        cdk.SecretValue.unsafePlainText('health-check'),
      ),
      description: 'Credential-free product health probes; header value grants no authority.',
    });

    const probes = [
      { id: 'ApiHealth', path: '/health' },
      { id: 'McpHealth', path: '/mcp/health' },
    ] as const;

    for (const probe of probes) {
      const destination = new events.ApiDestination(this, `${probe.id}Destination`, {
        connection,
        endpoint: `${apiEndpoint}${probe.path}`,
        httpMethod: events.HttpMethod.GET,
        rateLimitPerSecond: 1,
      });
      const rule = new events.Rule(this, `${probe.id}Schedule`, {
        description: `${probe.id} checks process health only; no release, data, or model query.`,
        schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      });
      rule.addTarget(
        new targets.ApiDestination(destination, {
          deadLetterQueue: canaryDlq,
          maxEventAge: cdk.Duration.hours(1),
          retryAttempts: 2,
        }),
      );

      const failedInvocations = new cloudwatch.Alarm(this, `${probe.id}FailedInvocations`, {
        alarmDescription: `${probe.id} could not complete after bounded retry.`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Events',
          metricName: 'FailedInvocations',
          dimensionsMap: { RuleName: rule.ruleName },
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: 0,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      failedInvocations.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
      failedInvocations.addOkAction(new cloudwatchActions.SnsAction(alertTopic));
    }

    const dlqAlarm = new cloudwatch.Alarm(this, 'HealthCanaryDlqNotEmpty', {
      alarmDescription: 'Health-canary DLQ contains failures; triage and drain to auto-resolve.',
      metric: canaryDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
    dlqAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));
  }
}
