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

    // Convert to Base64 - this is what LendingPad actually wants
    const base64Content = bufferData.toString('base64');
    console.log('Base64 length:', base64Content.length);

    const boundary = `----WebKitFormBoundary${Date.now()}${Math.random().toString(36)}`;
    const CRLF = '\r\n';

    // Build complete form as string
    let body = '';

    // Text fields
    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="company"${CRLF}${CRLF}`;
    body += `${fileMessage.lendingPadCompany}${CRLF}`;

    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="contact"${CRLF}${CRLF}`;
    body += `${fileMessage.lendingPadContact}${CRLF}`;

    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="loan"${CRLF}${CRLF}`;
    body += `${fileMessage.lendingPadId}${CRLF}`;

    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="name"${CRLF}${CRLF}`;
    body += `${fileMessage.title}.${fileMessage.fileExtension}${CRLF}`;

    // File as Base64 TEXT field (not binary file)
    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="file"; filename="${fileMessage.title}.${fileMessage.fileExtension}"${CRLF}`;
    body += `Content-Type: application/pdf${CRLF}${CRLF}`;
    body += `${base64Content}${CRLF}`;

    body += `--${boundary}--${CRLF}`;

    console.log('Form body length:', body.length);

    const url = `${process.env.LENDING_PAD_API_URL}/integrations/loans/documents/import`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LENDING_PAD_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body).toString()
      },
      body: body
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
