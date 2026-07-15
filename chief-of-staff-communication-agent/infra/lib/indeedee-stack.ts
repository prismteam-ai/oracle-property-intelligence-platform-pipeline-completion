import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Construct } from "constructs";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export interface IndeedeeStackProps extends StackProps {
  stage: string;
}

export class IndeedeeStack extends Stack {
  constructor(scope: Construct, id: string, props: IndeedeeStackProps) {
    super(scope, id, props);

    const appSecret = new secretsmanager.Secret(this, "AppSecret", {
      secretName: `indeedee/${props.stage}/app`,
      description: "Indeedee runtime secrets (populate after first deploy)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ placeholder: true }),
        generateStringKey: "INDEEDEE_SECRETS_KEY",
        excludePunctuation: true,
      },
    });

    const commonEnv = {
      NODE_ENV: "production",
      INDEEDEE_STAGE: props.stage,
      INDEEDEE_SECRETS_BACKEND: "secrets-manager",
      INDEEDEE_SSO_ENABLED: "true",
      SYNC_INTERVAL_MS: "0",
    };

    const apiHandler = new NodejsFunction(this, "ApiHandler", {
      entry: join(repoRoot, "apps/api/src/lambda/http-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(29),
      memorySize: 1024,
      logRetention: logs.RetentionDays.ONE_MONTH,
      depsLockFilePath: join(repoRoot, "pnpm-lock.yaml"),
      projectRoot: repoRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir, outputDir) => [
            `cp ${join(repoRoot, "pnpm-lock.yaml")} ${outputDir}/`,
          ],
        },
      },
      environment: {
        ...commonEnv,
        INDEEDEE_DB_URL: process.env.INDEEDEE_DB_URL ?? "file:/tmp/indeedee.db",
      },
    });

    const syncHandler = new NodejsFunction(this, "SyncHandler", {
      entry: join(repoRoot, "apps/api/src/lambda/sync-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(5),
      memorySize: 1024,
      logRetention: logs.RetentionDays.ONE_MONTH,
      depsLockFilePath: join(repoRoot, "pnpm-lock.yaml"),
      projectRoot: repoRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
      },
      environment: {
        ...commonEnv,
        INDEEDEE_DB_URL: process.env.INDEEDEE_DB_URL ?? "file:/tmp/indeedee.db",
        SYNC_OWNER_IDS: process.env.SYNC_OWNER_IDS ?? "",
      },
    });

    appSecret.grantRead(apiHandler);
    appSecret.grantRead(syncHandler);

    const bedrockPolicy = new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: ["*"],
    });
    apiHandler.addToRolePolicy(bedrockPolicy);
    syncHandler.addToRolePolicy(bedrockPolicy);

    const secretsBackendPolicy = new iam.PolicyStatement({
      actions: [
        "secretsmanager:GetSecretValue",
        "secretsmanager:CreateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:DeleteSecret",
      ],
      resources: [`arn:aws:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:indeedee/*`],
    });
    apiHandler.addToRolePolicy(secretsBackendPolicy);
    syncHandler.addToRolePolicy(secretsBackendPolicy);

    const httpApi = new HttpApi(this, "HttpApi", {
      apiName: `indeedee-${props.stage}`,
      defaultIntegration: new HttpLambdaIntegration("ApiIntegration", apiHandler),
    });

    new events.Rule(this, "SyncSchedule", {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(syncHandler)],
    });

    const webBucket = new s3.Bucket(this, "WebBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, "WebDeployment", {
      sources: [s3deploy.Source.asset(join(repoRoot, "apps/web/public"))],
      destinationBucket: webBucket,
    });

    const apiDomain = `${httpApi.apiId}.execute-api.${Stack.of(this).region}.amazonaws.com`;
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      originPath: "/",
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        "/mcp/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        "/health": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
      defaultRootObject: "index.html",
    });

    const siteUrl = `https://${distribution.distributionDomainName}`;
    apiHandler.addEnvironment("API_BASE_URL", siteUrl);
    syncHandler.addEnvironment("API_BASE_URL", siteUrl);

    new CfnOutput(this, "SiteUrl", { value: siteUrl });
    new CfnOutput(this, "HttpApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "AppSecretArn", { value: appSecret.secretArn });
    new CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
  }
}
