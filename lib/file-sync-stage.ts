import { Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { FileSyncStack } from './file-sync-stack';
import { FileSyncS3Stack } from './file-sync-s3-stack';

interface FileSyncStageProps extends StageProps {
  stage: string;
}

export class FileSyncStage extends Stage {
  constructor(scope: Construct, id: string, props: FileSyncStageProps) {
    super(scope, id, props);

    const stage = props.stage || 'dev';

    // Create the S3 stack first
    const s3Stack = new FileSyncS3Stack(this, 'FileSyncS3', {
      stage
    });

    // Create the main stack, passing the bucket from the S3 stack
    const mainStack = new FileSyncStack(this, 'FileSync', {
      stage,
      documentsBucket: s3Stack.documentsBucket  // Pass the S3 bucket reference
    });

    // Ensure S3 stack is deployed before main stack
    mainStack.addDependency(s3Stack);
  }
}
