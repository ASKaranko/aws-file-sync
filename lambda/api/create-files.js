import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';

//const BAD_REQUEST_CODE = 400;
const INTERNAL_SERVER_ERROR_REQUEST_CODE = 500;
const SUCCESS_PROCESSING_CODE = 202;
const MAX_MESSAGES_PER_CHUNK = 10;

export const handler = async (event, context) => {
  const res = {
    headers: {
      'Content-Type': 'application/json'
    }
  };

  //console.log('Received event:', JSON.stringify(event, null, 2));

  if (!event.body || event.body.length === 0) {
    res.statusCode = INTERNAL_SERVER_ERROR_REQUEST_CODE;
    res.body = JSON.stringify({ message: 'No body in the request' });
    return res;
  }

  try {
    await sendFileMessagesToSQS(context.awsRequestId, JSON.parse(event.body));

    res.statusCode = SUCCESS_PROCESSING_CODE;
    res.body = JSON.stringify({ message: 'Files are sent to SQS for creating in S3 and LendingPad' });
  } catch (error) {
    console.log('Error: ', error);
    res.statusCode = INTERNAL_SERVER_ERROR_REQUEST_CODE;
    res.body = JSON.stringify({ message: 'Error processing files', error: error.message });
  }
  return res;
};

/**
 * Send file messages to SQS in chunks
 * @param requestId - The request identifier
 * @param {Array[Object]} messages - The request body containing file messages
 * @returns {Promise<void>}
 */
async function sendFileMessagesToSQS(requestId, messages) {
  const sqsClient = new SQSClient({});
  const SQS_URL = process.env.FILE_SYNC_SQS_URL;

  const messagesChunks = [];
  for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_CHUNK) {
    messagesChunks.push(messages.slice(i, i + MAX_MESSAGES_PER_CHUNK));
  }

  let successCount = 0;
  const totalMessages = messages.length;

  for (const chunk of messagesChunks) {
    try {
      const entries = chunk.map((message, index) => ({
        Id: `${requestId}${index}`,
        MessageBody: JSON.stringify(message)
      }));

      // Log the entries to be sent
      console.info('SQS entries:', entries);

      const command = new SendMessageBatchCommand({
        QueueUrl: SQS_URL,
        Entries: entries
      });

      const response = await sqsClient.send(command);
      
      successCount += response.Successful?.length || 0;
      if (response.Failed && response.Failed.length > 0) {
        console.error('Failed to send some messages:', response.Failed);
      }
    } catch (error) {
      console.error('Error sending messages to SQS:', error);
    }
  }

  if (successCount === 0 && totalMessages > 0) {
    throw new Error(`Failed to publish any messages to SQS. Total messages: ${totalMessages}`);
  }

  console.info(`Successfully sent ${successCount} messages to SQS`);
}
