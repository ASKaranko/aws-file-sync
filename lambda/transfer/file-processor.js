import { Buffer } from 'node:buffer';
import FormData from 'form-data';
import axios from 'axios';

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
  console.log('SF Content-Type:', response.headers.get('content-type'));
  console.log('SF Content-Length:', response.headers.get('content-length'));

  // Get the binary data as ArrayBuffer
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  // Debug the buffer content
  console.log('ArrayBuffer size:', arrayBuffer.byteLength);
  console.log('Buffer size:', buffer.length);
  console.log('First 10 bytes as hex:', buffer.slice(0, 10).toString('hex'));
  console.log('First 10 bytes as string:', buffer.slice(0, 10).toString());
  console.log('Is PDF? (starts with %PDF):', buffer.slice(0, 4).toString() === '%PDF');
  
  return buffer;
}

async function uploadFile(fileMessage, bufferData) {
  try {
    console.log('Starting upload to LendingPad...');
    console.log('Buffer size:', bufferData.length, 'bytes');
    console.log('Buffer is PDF?', bufferData.slice(0, 4).toString() === '%PDF');

    // Convert binary PDF to Base64 string
    const base64Content = bufferData.toString('base64');
    console.log('Base64 string length:', base64Content.length);

    // Create form with text fields only (no binary file upload)
    const form = new FormData();
    form.append('company', fileMessage.lendingPadCompany);
    form.append('contact', fileMessage.lendingPadContact);
    form.append('loan', fileMessage.lendingPadId);
    form.append('name', `${fileMessage.title}.${fileMessage.fileExtension}`);
    
    // Send Base64 as plain text field (this is what LendingPad expects)
    form.append('file', base64Content, {
      filename: `${fileMessage.title}.${fileMessage.fileExtension}`
    });

    const url = `${process.env.LENDING_PAD_API_URL}/integrations/loans/documents/import`;

    const response = await axios.post(url, form, {
      headers: {
        'Authorization': `Bearer ${process.env.LENDING_PAD_API_KEY}`,
        ...form.getHeaders()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log('LP Response status:', response.status);
    console.log('LP Response data:', response.data);

    console.info('File uploaded to LendingPad:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error uploading file:', error);
    throw error;
  }
}
