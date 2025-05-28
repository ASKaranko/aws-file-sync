import { Stack, StackProps, CfnOutput, Tags, RemovalPolicy, Duration, SecretValue } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';
import {
  LambdaRestApi,
  EndpointType,
  LogGroupLogDestination,
  AccessLogFormat,
  MethodLoggingLevel,
  AuthorizationType,
  LambdaIntegration
} from 'aws-cdk-lib/aws-apigateway';
import { Queue, QueueEncryption, RedrivePermission } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';

interface FileSyncStackProps extends StackProps {
  stage: string;
  documentsBucket: s3.Bucket;  // Add bucket reference
}

export class FileSyncStack extends Stack {
  constructor(scope: Construct, id: string, props: FileSyncStackProps) {
    super(scope, id, props);

    const stage = props.stage || 'dev';

    const sandboxDomain = 'https://emortgage--orisa.sandbox.my.salesforce.com';
    const productionDomain = 'https://emortgage.my.salesforce.com';
    const salesforceFileSyncResultsAPI = `${stage === 'prod' ? productionDomain : sandboxDomain}/services/apexrest/file-sync/v1/results/`;
    const lendingPadAPI = 'https://api.lendingpad.com';
    const secretStoreNameForSFExtClientAppCreds = `${stage}/salesforce/sf-ext-client-app-creds`;
    const secretStoreNameForBasicAuthLPCreds = 'prod/lending-pad/basic-auth-creds';

    new CfnOutput(this, 'Stage', {
      value: stage,
      description: 'The deployment stage'
    });

    //stack level tags
    Tags.of(this).add('Project', 'file-sync');
    Tags.of(this).add('Environment', stage);

    const fileSyncCreateRouterLogGroup = new LogGroup(this, 'FileSyncCreateRouterLogGroup', {
      logGroupName: `/aws/lambda/${stage}-file-sync-create-router`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const fileProcessorLogGroup = new LogGroup(this, 'FileSyncProcessorLogGroup', {
      logGroupName: `/aws/lambda/${stage}-file-sync-processor`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const apiGatewayLogGroup = new LogGroup(this, 'ApiGatewayLogGroup', {
      logGroupName: `/aws/apigateway/${stage}-file-sync-api`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const fileSyncCreateRouterLambda = new NodejsFunction(this, 'FileSyncCreateRouterLambda', {
      functionName: `${stage}-file-sync-create-router`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.X86_64,
      entry: path.join(__dirname, '../lambda/api/create-files.js'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(20),
      logGroup: fileSyncCreateRouterLogGroup
    });

    const fileProcessorLambda = new NodejsFunction(this, 'FileSyncProcessorLambda', {
      functionName: `${stage}-file-sync-processor`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.X86_64,
      entry: path.join(__dirname, '../lambda/transfer/file-processor.js'),
      handler: 'handler',
      memorySize: 512,
      timeout: Duration.minutes(5),
      logGroup: fileProcessorLogGroup,
      environment: {
        SALESFORCE_CLIENT_ID: SecretValue.secretsManager(`${secretStoreNameForSFExtClientAppCreds}`, {
          jsonField: 'client_id'
        }).unsafeUnwrap(),
        SALESFORCE_CLIENT_SECRET: SecretValue.secretsManager(`${secretStoreNameForSFExtClientAppCreds}`, {
          jsonField: 'client_secret'
        }).unsafeUnwrap(),
        LENDING_PAD_USERNAME: SecretValue.secretsManager(`${secretStoreNameForBasicAuthLPCreds}`, {
          jsonField: 'username'
        }).unsafeUnwrap(),
        LENDING_PAD_PASSWORD: SecretValue.secretsManager(`${secretStoreNameForBasicAuthLPCreds}`, {
          jsonField: 'password'
        }).unsafeUnwrap(),
        SALESFORCE_DOMAIN: stage === 'prod' ? productionDomain : sandboxDomain,
        SALESFORCE_FILE_SYNC_RESULTS_API: salesforceFileSyncResultsAPI,
        LENDING_PAD_API_URL: lendingPadAPI,
        S3_BUCKET_NAME: props.documentsBucket.bucketName
      }
    });

    props.documentsBucket.grantReadWrite(fileProcessorLambda);

    const api = new LambdaRestApi(this, 'FileSyncApi', {
      restApiName: `${stage}-file-sync-api`,
      description: 'API for processing file sync',
      handler: fileSyncCreateRouterLambda,
      endpointTypes: [EndpointType.REGIONAL],
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.DESTROY,
      proxy: false,
      deployOptions: {
        stageName: stage,
        description: `Deployment for ${stage} environment`,
        metricsEnabled: true,
        throttlingRateLimit: 200,
        throttlingBurstLimit: 300,
        accessLogDestination: new LogGroupLogDestination(apiGatewayLogGroup),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: MethodLoggingLevel.ERROR
      },
      defaultMethodOptions: {
        authorizationType: AuthorizationType.NONE
      }
    });

    // Add /file-sync resource with POST method
    const fileSyncApiResource = api.root.addResource('file-sync');

    fileSyncApiResource.addMethod(
      'POST',
      new LambdaIntegration(fileSyncCreateRouterLambda, {
        proxy: true,
        allowTestInvoke: true
      })
    );

    new CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'The URL of the API Gateway endpoint'
    });

    const fileSyncDLQ = new Queue(this, 'FileSyncDLQ', {
      queueName: `${stage}-file-sync-dlq`,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY
    });

    const fileSyncQueue = new Queue(this, 'FileSyncQueue', {
      queueName: `${stage}-file-sync-queue`,
      encryption: QueueEncryption.SQS_MANAGED,
      deliveryDelay: Duration.seconds(0),
      visibilityTimeout: Duration.minutes(10), // best practice is greater that 6 × function timeout
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(1),
      maxMessageSizeBytes: 262144, // 256KB
      deadLetterQueue: {
        queue: fileSyncDLQ,
        maxReceiveCount: 2
      },
      redriveAllowPolicy: {
        redrivePermission: RedrivePermission.DENY_ALL
      },
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Grant the Lambda function permission to send messages to the queue
    fileSyncQueue.grantSendMessages(fileSyncCreateRouterLambda);
    fileSyncCreateRouterLambda.addEnvironment('FILE_SYNC_SQS_URL', fileSyncQueue.queueUrl);

    fileProcessorLambda.addEventSource(
      new SqsEventSource(fileSyncQueue, {
        batchSize: 1,
        maxBatchingWindow: Duration.seconds(0),
        maxConcurrency: 10,
        reportBatchItemFailures: true
      })
    );

    new CfnOutput(this, 'FileSyncQueueUrl', {
      value: fileSyncQueue.queueUrl,
      description: 'The URL of the File Sync SQS queue'
    });
  }
}
