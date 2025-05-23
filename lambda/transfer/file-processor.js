import { Buffer } from 'node:buffer';
import FormData from 'form-data';

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

  let sfReadable;
  let fileMessage;
  try {
    const { access_token, instance_url } = authResponse;
    fileMessage = JSON.parse(event.Records[0].body);
    const contentVersionId = fileMessage.contentVersionId;
    sfReadable = await downloadFile(access_token, instance_url, contentVersionId);
  } catch (error) {
    console.log(error);
    throw error;
  }

  await uploadFile(fileMessage, sfReadable);
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

  console.log('SF response headers:', response.headers);

  // Get the binary data as ArrayBuffer
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function uploadFile(fileMessage, bufferData) {
  try {
    console.log('Starting upload to LendingPad...');
    console.log('Buffer size:', bufferData.length, 'bytes');

    // Convert to Base64 if LendingPad expects it
    const base64Content = bufferData.toString('base64');

    // Create form with Node.js form-data
    const form = new FormData();
    form.append('company', fileMessage.lendingPadCompany);
    form.append('contact', fileMessage.lendingPadContact);
    form.append('loan', fileMessage.lendingPadId);
    form.append('name', `${fileMessage.title}.${fileMessage.fileExtension}`);

    // Fix: Set correct content type for PDF
    form.append('file', base64Content, {
      filename: `${fileMessage.title}.${fileMessage.fileExtension}`,
      contentType: 'application/pdf',  // Changed from 'text/plain'
      knownLength: base64Content.length
    });

    console.log('Getting form buffer...');
    const formBuffer = await form.getBuffer();
    console.log('Form buffer size:', formBuffer.length, 'bytes');

    const url = `${process.env.LENDING_PAD_API_URL}/integrations/loans/documents/import`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LENDING_PAD_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${form.getBoundary()}`,
        'Content-Length': formBuffer.length.toString()
      },
      body: formBuffer
    });

    console.log('LP Response status:', response.status);
    const responseBody = await response.text();
    console.log('LP Raw response:', responseBody);

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status} ${response.statusText} - ${responseBody}`);
    }

    const responseData = JSON.parse(responseBody);
    console.info('File uploaded to LendingPad:', responseData);
    return responseData;
  } catch (error) {
    console.error('Error uploading file:', error);
    throw error;
  }
}
