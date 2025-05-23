import { Buffer } from 'node:buffer';
// import FormData from 'form-data'; for LP
// import axios from 'axios'; for LP

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

  //await uploadFileToLP(fileMessage, sfReadable);
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

  // Get the binary data as ArrayBuffer
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  return buffer;
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
