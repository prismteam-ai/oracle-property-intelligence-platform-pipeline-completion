#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { IndeedeeStack } from "../lib/indeedee-stack.js";

const app = new cdk.App();

const stage = app.node.tryGetContext("stage") ?? process.env.INDEEDEE_STAGE ?? "dev";

new IndeedeeStack(app, `Indeedee-${stage}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-2",
  },
  stage,
  description: "Indeedee Chief of Staff Communication Agent — API, UI, and sync",
});
