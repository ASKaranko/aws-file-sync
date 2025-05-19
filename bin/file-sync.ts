#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { FileSyncStage } from '../lib/file-sync-stage';

const app = new App();

// Create a stage for each environment
new FileSyncStage(app, 'dev', {
  stage: 'dev',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});

// You can add more stages for other environments
new FileSyncStage(app, 'prod', {
  stage: 'prod',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});