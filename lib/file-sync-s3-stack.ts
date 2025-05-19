import { Stack, StackProps, CfnOutput, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class FileSyncS3Stack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // new CfnOutput(this, 'Stage', {
    //   value: stage,
    //   description: 'The deployment stage'
    // });

    // //stack level tags
    // Tags.of(this).add('Project', 'vendor-leads');
    // Tags.of(this).add('Environment', stage);
  }
}