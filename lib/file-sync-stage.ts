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

    // Create the database stack first
    new FileSyncStack(this, 'FileSync', {
      stage
    });

    // Create the main stack, passing the table from the database stack
    // new FileSyncS3Stack(this, 'FileSyncS3', {
    //   stage,
    //   fileSyncBucket: databaseStack.fileSyncBucket
    // });
  }
}
