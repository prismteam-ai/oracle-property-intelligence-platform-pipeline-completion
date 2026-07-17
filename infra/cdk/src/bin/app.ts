import * as cdk from 'aws-cdk-lib';

import { OracleFoundationStack } from '../lib/oracle-foundation-stack.js';

const app = new cdk.App();

new OracleFoundationStack(app, 'OracleFoundationStack', {
  env: {
    account: '417242953053',
    region: 'us-east-2',
  },
});
