import { Stack, StackProps, CfnOutput, Tags, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

interface FileSyncS3StackProps extends StackProps {
  stage: string;
}

export class FileSyncS3Stack extends Stack {
  public readonly documentsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FileSyncS3StackProps) {
    super(scope, id, props);

    const stage = props.stage || 'dev';

    // Follow AWS naming rules: lowercase, hyphen-separated, include account/region for uniqueness
    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketName: `${stage}-file-sync-documents-${this.account}-${this.region}`,
      versioned: true,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000
        }
      ]
    });

    // Output the bucket name and ARN
    new CfnOutput(this, 'DocumentsBucketName', {
      value: this.documentsBucket.bucketName,
      description: 'Name of the S3 bucket for storing documents',
      exportName: `${this.stackName}-DocumentsBucketName`
    });

    new CfnOutput(this, 'DocumentsBucketArn', {
      value: this.documentsBucket.bucketArn,
      description: 'ARN of the S3 bucket for storing documents',
      exportName: `${this.stackName}-DocumentsBucketArn`
    });

    // Add stack-level tags
    Tags.of(this).add('Project', 'file-sync');
    Tags.of(this).add('Environment', stage);
  }
}
