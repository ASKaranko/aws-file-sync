import { Buffer } from 'node:buffer';
import { FormData } from 'undici';

import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import mime from 'mime-types';

const UPLOAD_TO_S3_PART_SIZE = 10 * 1024 * 1024; // 10MB
const actionType = {
  FILE_CREATE: 'FILE_CREATE',
  FILE_UPDATE: 'FILE_UPDATE'
};

export const handler = async (event) => {
  console.info('Received SQS event:', JSON.stringify(event, null, 2));

  let authResponse;
  try {
    authResponse = await connectToSF();
  } catch (error) {
    console.error(error);
    throw error;
  }

  console.info('Salesforce authentication successful');

  try {
    const fileMessage = JSON.parse(event.Records[0].body);

    switch (fileMessage.actionType) {
      case actionType.FILE_CREATE:
        await handleFileUpload(authResponse, fileMessage);
        break;

      case actionType.FILE_UPDATE:
        await handleFileUpload(authResponse, fileMessage);
        break;

      default:
        console.warn('Unknown action type:', fileMessage.actionType);
        throw new Error(`Unsupported action type: ${fileMessage.actionType}`);
    }
  } catch (error) {
    console.error('File operation failed:', error);
    throw error;
  }
};

async function handleFileUpload(authResponse, fileMessage) {
  const { access_token, instance_url } = authResponse;
  const contentVersionId = fileMessage.contentVersionId;

  let sourceStream;
  try {
    sourceStream = await downloadFile(access_token, instance_url, contentVersionId);
  } catch (error) {
    console.error('Failed to download file:', error);
    throw error;
  }

  // tee() splits stream into two independent streams
  const [s3WebStream, lpWebStream] = sourceStream.tee();

  console.log('Starting concurrent uploads with teed streams...');

  const [s3Result, lpResult] = await Promise.allSettled([
    uploadToS3(fileMessage, s3WebStream),
    uploadToLP(fileMessage, lpWebStream)
  ]);

  let uploadResponse;
  if (s3Result.status === 'fulfilled') {
    uploadResponse = s3Result.value;
    console.log('S3 upload successful');
  } else {
    console.error('S3 upload failed:', s3Result.reason);
    throw new Error('S3 upload failed');
  }

  if (lpResult.status === 'fulfilled') {
    console.log('LendingPad upload successful');
  } else {
    console.error('LendingPad upload failed:', lpResult.reason);
  }

  try {
    await sendFileSyncResultToSF(access_token, uploadResponse, fileMessage);
  } catch (error) {
    console.error(error);
  }
}

/**
 * Connect to Salesforce using OAuth2 client credentials
 * @returns auth response from Salesforce
 */
async function connectToSF() {
  // eslint-disable-next-line no-undef
  const response = await fetch(process.env.SALESFORCE_DOMAIN + '/services/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      scope: 'api'
    },
    // eslint-disable-next-line no-undef
    body: `grant_type=client_credentials&client_id=${process.env.SALESFORCE_CLIENT_ID}&client_secret=${process.env.SALESFORCE_CLIENT_SECRET}`
  });
  if (!response.ok) {
    throw new Error(`Failed to connect to Salesforce: ${response.statusText}`);
  }

  return await response.json();
}

async function downloadFile(authToken, instanceURL, contentVersionId) {
  const url = `${instanceURL}/services/data/v62.0/sobjects/ContentVersion/${contentVersionId}/VersionData`;
  console.log('URL:', url);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${authToken}`,
      Accept: '*/*'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download file from Salesforce: ${response.status} ${response.statusText}`);
  }

  return response.body;
}

async function uploadToS3(fileMessage, stream) {
  console.log('Starting upload to S3...');

  const s3Client = new S3Client({});

  // Folder structure in S3
  const s3Key = `${fileMessage.sfParentObjectName}/${fileMessage.sfParentObjectId}/${fileMessage.title}.${fileMessage.fileExtension}`;

  const uploadParams = {
    // eslint-disable-next-line no-undef
    Bucket: process.env.S3_BUCKET_NAME,
    Key: s3Key,
    Body: stream,
    ContentType: mime.lookup(fileMessage.fileExtension) || 'application/pdf',
    Metadata: {
      source: 'Salesforce',
      'sf-parent-object-name': fileMessage.sfParentObjectName,
      'sf-parent-object-id': fileMessage.sfParentObjectId,
      'folder-name': fileMessage.folder,
      'content-document-id': fileMessage.contentDocumentId,
      'content-version-id': fileMessage.contentVersionId
    }
  };

  const upload = new Upload({
    client: s3Client,
    params: uploadParams,
    partSize: UPLOAD_TO_S3_PART_SIZE,
    queueSize: 2
  });

  const result = await upload.done();

  console.log('File uploaded to S3 successfully:', result);

  return {
    location: result.Location,
    bucket: result.Bucket,
    key: result.Key,
    etag: result.ETag,
    versionId: result.VersionId
  };
}

async function uploadToLP(fileMessage, stream) {
  console.log('Starting upload to LendingPad...');

  // Create basic auth credentials
  // eslint-disable-next-line no-undef
  const username = process.env.LENDING_PAD_USERNAME;
  // eslint-disable-next-line no-undef
  const password = process.env.LENDING_PAD_PASSWORD;
  const basicAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  const contentType = mime.lookup(fileMessage.fileExtension) || 'application/pdf';
  const fileBlob = new Blob([stream], { type: contentType });
  console.log('File blob created from stream');

  // Create FormData from undici
  const form = new FormData();
  form.append('company', fileMessage.lendingPadCompany);
  form.append('contact', fileMessage.lendingPadContact);
  form.append('loan', fileMessage.lendingPadId);
  form.append('name', `${fileMessage.title}.${fileMessage.fileExtension}`);

  // Append the stream directly (undici FormData supports streams)
  form.append('file', fileBlob, `${fileMessage.title}.${fileMessage.fileExtension}`);

  // eslint-disable-next-line no-undef
  const url = `${process.env.LENDING_PAD_API_URL}/integrations/loans/documents/import`;

  console.log('LendingPad URL:', url);
  console.log('Using basic auth for user:', username);
  console.log('Form data prepared with streaming blob...');

  // Use fetch with FormData (undici FormData works with fetch)
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuth
    },
    body: form
  });

  console.log('LP Response status:', response.status);
  console.log('LP Response headers:', Object.fromEntries(response.headers.entries()));

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LendingPad upload failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  let responseData;
  try {
    responseData = await response.json();
  } catch (parseError) {
    console.error('Failed to parse LP response as JSON:', parseError);
    throw new Error('Invalid JSON response from LendingPad');
  }

  console.log('LP Response data:', responseData);

  switch (responseData.status?.code) {
    case 1:
      // Success
      console.info(`File uploaded to LendingPad successfully. Document ID: ${responseData.id}`);
      return responseData;

    case 2:
      // Error
      console.error(`LendingPad upload failed: ${responseData.status?.description}`);
      throw new Error(`LendingPad error: ${responseData.status?.description}`);
  }
}

/**
 * Send file sync result to Salesforce
 * @param {string} authToken - Salesforce OAuth2 access token
 * @param {Object} uploadResponse - Response from S3 upload
 * @param {Object} fileMessage - Original file message containing metadata
 * @returns auth response from Salesforce
 */
async function sendFileSyncResultToSF(authToken, uploadResponse, fileMessage) {
  const response = await fetch(process.env.SALESFORCE_FILE_SYNC_RESULTS_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    // sending an array of objects to match the expected format to allow for multiple files in the future
    body: JSON.stringify([
      {
        s3Bucket: uploadResponse.bucket,
        s3Key: uploadResponse.key,
        s3Location: uploadResponse.location,
        s3Etag: uploadResponse.etag,
        s3VersionId: uploadResponse.versionId,
        s3Region: process.env.AWS_REGION,
        ...fileMessage // Spread the original file message for context
      }
    ])
  });
  if (!response.ok) {
    throw new Error(`Failed to send file sync results to Salesforce: ${response.status} ${response.statusText}`);
  }

  const responseFromSF = await response.json();
  console.log('Response from SF for a sent file sync result:', JSON.stringify(responseFromSF, null, 2));
  return responseFromSF;
}
