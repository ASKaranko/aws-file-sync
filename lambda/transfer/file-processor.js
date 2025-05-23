import { Buffer } from 'node:buffer';
// import FormData from 'form-data'; for LP
// import axios from 'axios'; for LP

import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from "@aws-sdk/lib-storage";
import mime from 'mime-types';

const UPLOAD_TO_S3_PART_SIZE = 10 * 1024 * 1024; // 10MB

export const handler = async (event) => {
  console.info('Received SQS event:', JSON.stringify(event, null, 2));

  let authResponse;
  try {
    authResponse = await connectToSalesforce();
  } catch (error) {
    console.error(error);
    throw error;
  }

  console.info('Auth response:', authResponse);

  let stream;
  let fileMessage;
  try {
    const { access_token, instance_url } = authResponse;
    fileMessage = JSON.parse(event.Records[0].body);
    const contentVersionId = fileMessage.contentVersionId;
    stream = await downloadFile(access_token, instance_url, contentVersionId);
  } catch (error) {
    console.log(error);
    throw error;
  }

  await uploadToS3(fileMessage, stream);
  //await uploadFileToLP(fileMessage, bufferedData);
  console.info('File uploaded to S3 and LendingPad ');
};

/**
 * Connect to Salesforce using OAuth2 client credentials
 * @returns auth response from Salesforce
 */
async function connectToSalesforce() {
  const response = await fetch(process.env.SALESFORCE_DOMAIN + '/services/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      scope: 'api'
    },
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
  try {
    console.log('Starting upload to S3...');
    
    const s3Client = new S3Client({});

    // Folder structure in S3
    const s3Key = `Opportunities/${fileMessage.opportunityId}/${fileMessage.title}.${fileMessage.fileExtension}`;

    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key,
      Body: stream,
      ContentType: mime.lookup(fileMessage.fileExtension) || 'application/pdf',
      Metadata: {
        'source': 'salesforce',
        'opportunity-id': fileMessage.opportunityId,
        'original-title': fileMessage.title
      }
    };

    const upload = new Upload({
      client: s3Client,
      params: uploadParams,
      partSize: UPLOAD_TO_S3_PART_SIZE,
      queueSize: 2,
    });

    const result = await upload.done();

    console.log('File uploaded to S3:', result);

    return {
      location: result.Location,
      bucket: result.Bucket,
      key: result.Key,
      etag: result.ETag
    };
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw error;
  }
}

// async function uploadFileToLP(fileMessage, bufferData) {
//   try {
//     console.log('Starting upload to LendingPad...');
//     console.log('Buffer size:', bufferData.length, 'bytes');

//     // Create form with Node.js form-data
//     const form = new FormData();
//     form.append('company', fileMessage.lendingPadCompany);
//     form.append('contact', fileMessage.lendingPadContact);
//     form.append('loan', fileMessage.lendingPadId);
//     form.append('name', `${fileMessage.title}.${fileMessage.fileExtension}`);

//     // Send the binary buffer directly
//     form.append('file', bufferData, {
//       filename: `${fileMessage.title}.${fileMessage.fileExtension}`,
//       contentType: 'application/pdf',
//       knownLength: bufferData.length
//     });

//     const url = `${process.env.LENDING_PAD_API_URL}/integrations/loans/documents/import`;

//     // Use axios instead of fetch for form-data streams
//     const response = await axios.post(url, form, {
//       headers: {
//         'Authorization': `Bearer ${process.env.LENDING_PAD_API_KEY}`,
//         ...form.getHeaders()  // Let form-data set correct headers
//       },
//       maxContentLength: Infinity,
//       maxBodyLength: Infinity
//     });

//     console.log('LP Response status:', response.status);
//     console.log('LP Response data:', response.data);

//     console.info('File uploaded to LendingPad:', response.data);
//     return response.data;
//   } catch (error) {
//     console.error('Error uploading file:', error);
//     throw error;
//   }
// }
