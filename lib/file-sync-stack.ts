import { Stack, StackProps, CfnOutput, Tags, RemovalPolicy, Duration } from 'aws-cdk-lib';
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
  AuthorizationType
} from 'aws-cdk-lib/aws-apigateway';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

interface FileSyncStackProps extends StackProps {
  stage: string;
}

export class FileSyncStack extends Stack {
  constructor(scope: Construct, id: string, props: FileSyncStackProps) {
    super(scope, id, props);

    const stage = props.stage || 'dev';

    new CfnOutput(this, 'Stage', {
      value: stage,
      description: 'The deployment stage'
    });

    //stack level tags
    Tags.of(this).add('Project', 'file-sync');
    Tags.of(this).add('Environment', stage);

    const fileSyncCreateFnLogGroup = new LogGroup(this, 'FileSyncCreateFnLogGroup', {
      logGroupName: `/aws/lambda/${stage}-file-sync-create-router`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const apiGatewayLogGroup = new LogGroup(this, 'ApiGatewayLogGroup', {
      logGroupName: `/aws/apigateway/${stage}-file-sync-api`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const fileSyncCreateRouterLambda = new NodejsFunction(this, 'FileSyncCreateRouterLambda', {
      functionName: `${stage}-file-sync-create-router-lambda`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.X86_64,
      entry: path.join(__dirname, '../lambda/api/create-files.js'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(20),
      logGroup: fileSyncCreateFnLogGroup
    });

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
    fileSyncApiResource.addMethod('POST');

    new CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'The URL of the API Gateway endpoint'
    });
  }
}
