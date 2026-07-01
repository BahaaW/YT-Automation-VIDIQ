import { google } from 'googleapis';
import https from 'https';

const oauth2Client = new google.auth.OAuth2('id', 'secret', 'http://localhost');

console.log('Transporter class:', oauth2Client.transporter.constructor.name);
console.log('Transporter keys:', Object.keys(oauth2Client.transporter));
console.log('Transporter defaults:', oauth2Client.transporter.defaults);

const agent = new https.Agent({ keepAlive: false });
oauth2Client.transporter.defaults = {
  ...(oauth2Client.transporter.defaults || {}),
  httpsAgent: agent
};

console.log('Updated transporter defaults:', oauth2Client.transporter.defaults);
