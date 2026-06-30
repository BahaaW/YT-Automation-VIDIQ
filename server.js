import express from 'express';
import { Telegraf } from 'telegraf';
import { google } from 'googleapis';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration management
const configPath = path.join(__dirname, 'config.json');
let config = {
  telegram_token: '',
  telegram_chat_id: '',
  vidiq_api_key: '',
  daily_schedule_time: '09:00', // HH:MM
  state: 'idle',
  history: [],
  logs: []
};

function loadConfig() {
  if (fs.existsSync(configPath)) {
    try {
      config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (e) {
      log('Error reading config.json: ' + e.message);
    }
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    log('Error writing config.json: ' + e.message);
  }
}

loadConfig();

function log(msg) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${msg}`;
  console.log(entry);
  config.logs.push(entry);
  if (config.logs.length > 200) config.logs.shift();
  saveConfig();
}

// Telegram Bot Setup
let bot;
function initTelegramBot() {
  if (!config.telegram_token) {
    log('Telegram Token is missing. Bot is offline.');
    return;
  }
  
  try {
    bot = new Telegraf(config.telegram_token);
    
    bot.start((ctx) => {
      config.telegram_chat_id = String(ctx.chat.id);
      saveConfig();
      log(`New chat initialized. Telegram Chat ID registered: ${config.telegram_chat_id}`);
      ctx.reply('Hello! I am your VidIQ AutoClipper Bot. I have registered this chat ID and will prompt you here daily for new videos.');
    });

    bot.command('status', (ctx) => {
      ctx.reply(`Bot Status: ${config.state}\nLast run: ${config.last_run || 'Never'}\nYouTube Connected: ${hasYoutubeAuth()}`);
    });

    bot.command('clip', async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1).join(' ');
      if (!args) {
        return ctx.reply('Please specify parameters. Example: /clip https://youtube.com/watch?v=123 | Focus on funny parts');
      }
      handleTriggerInput(args, ctx);
    });

    bot.on('text', (ctx) => {
      if (config.state === 'waiting_for_input') {
        handleTriggerInput(ctx.message.text, ctx);
      } else {
        ctx.reply(`Bot is currently ${config.state}. Use /clip [url] | [prompt] to force a job.`);
      }
    });

    bot.launch();
    log('Telegram bot successfully launched.');
  } catch (e) {
    log('Failed to launch Telegram bot: ' + e.message);
  }
}

initTelegramBot();

// YouTube OAuth Setup
const oauthTokenPath = path.join(__dirname, 'oauth_token.json');
const clientSecretsPath = path.join(__dirname, 'client_secrets.json');
let oauth2Client = null;

function initYoutubeAuth() {
  let clientId = process.env.YOUTUBE_CLIENT_ID;
  let clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  let redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  
  if (fs.existsSync(clientSecretsPath)) {
    try {
      const content = JSON.parse(fs.readFileSync(clientSecretsPath, 'utf8'));
      const keys = content.web || content.installed;
      if (keys) {
        clientId = keys.client_id;
        clientSecret = keys.client_secret;
        redirectUri = keys.redirect_uris ? keys.redirect_uris[0] : redirectUri;
      }
    } catch (e) {
      log('Error reading client_secrets.json: ' + e.message);
    }
  }
  
  if (!clientId || !clientSecret) {
    log('YouTube credentials missing. Please set YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET or provide client_secrets.json. YouTube uploading is disabled.');
    return;
  }
  
  try {
    oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      redirectUri || 'http://localhost:' + PORT + '/api/auth/youtube/callback'
    );
    
    if (fs.existsSync(oauthTokenPath)) {
      const token = JSON.parse(fs.readFileSync(oauthTokenPath, 'utf8'));
      oauth2Client.setCredentials(token);
      log('YouTube OAuth credentials loaded from file.');
    }
  } catch (e) {
    log('Failed to initialize YouTube auth: ' + e.message);
  }
}

initYoutubeAuth();

function hasYoutubeAuth() {
  return oauth2Client !== null && oauth2Client.credentials && oauth2Client.credentials.access_token !== undefined;
}

// Daily Cron Check (Runs every minute to see if it matches schedule_time)
setInterval(() => {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const currentTime = `${hours}:${minutes}`;
  
  if (currentTime === config.daily_schedule_time && config.state === 'idle') {
    triggerDailyPrompt();
  }
}, 60000);

async function triggerDailyPrompt() {
  if (!bot || !config.telegram_chat_id) {
    log('Cannot send daily prompt: Bot or Chat ID is not configured.');
    return;
  }
  
  config.state = 'waiting_for_input';
  saveConfig();
  log('Daily prompt triggered. Waiting for user input.');
  
  try {
    await bot.telegram.sendMessage(config.telegram_chat_id, 
      '🚨 **Daily Video Prompt Needed!**\n\n' +
      'Please reply to this message with the **YouTube Link** of the video you want to make clips from, followed by a **prompt** for VidIQ.\n\n' +
      'Format: `https://youtube.com/watch?v=xxx | Focus on the funniest moments`',
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    log('Error sending Telegram daily message: ' + e.message);
  }
}

async function handleTriggerInput(text, ctx) {
  const parts = text.split('|');
  const url = parts[0]?.trim();
  const prompt = parts[1]?.trim() || 'Highlight key highlights';
  
  if (!url || !url.startsWith('http')) {
    if (ctx) ctx.reply('⚠️ Invalid URL. Please provide a valid YouTube link.');
    return;
  }
  
  config.state = 'vidiq_processing';
  config.last_run = new Date().toISOString();
  saveConfig();
  
  const runEntry = {
    id: Date.now().toString(),
    timestamp: config.last_run,
    url,
    prompt,
    status: 'processing',
    clips: []
  };
  config.history.unshift(runEntry);
  saveConfig();
  
  if (ctx) ctx.reply('🚀 Starting clipping job on VidIQ... I will notify you once processing begins and finishes.');
  
  startClippingPipeline(runEntry, url, prompt);
}

// VidIQ Clipping Pipeline
async function startClippingPipeline(runEntry, url, prompt) {
  log(`Submitting clipping job to VidIQ for URL: ${url}`);
  
  let client;
  try {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(__dirname, 'vidiq_wrapper.js')]
    });
    
    client = new Client({ name: 'vidiq-telegram-bot', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    
    log('MCP client connected to VidIQ wrapper.');
    
    const response = await client.callTool({
      name: 'vidiq_generate_clips',
      arguments: {
        videoUrl: url,
        prompt: prompt,
        captionStyle: 'Loud & Clear'
      }
    });
    
    log(`VidIQ clipping job submitted. Response: ${JSON.stringify(response)}`);
    const responseData = typeof response === 'string' ? JSON.parse(response) : response;
    // Handle either stringified JSON or direct object
    const mcpJobId = responseData.mcpJobId || responseData.content?.[0]?.text ? JSON.parse(responseData.content[0].text).mcpJobId : null;
    
    if (!mcpJobId) {
      throw new Error('Failed to extract mcpJobId from VidIQ response.');
    }
    
    runEntry.mcpJobId = mcpJobId;
    saveConfig();
    
    if (bot && config.telegram_chat_id) {
      bot.telegram.sendMessage(config.telegram_chat_id, `⏳ VidIQ processing started. Job ID: \`${mcpJobId}\`. I am polling for completion.`);
    }
    
    pollVidIQJob(client, runEntry);
    
  } catch (e) {
    log(`VidIQ Submission Failed: ${e.message}`);
    failRun(runEntry, `VidIQ Submission Failed: ${e.message}`);
    if (client) {
      try { await client.close(); } catch (_) {}
    }
  }
}

async function pollVidIQJob(client, runEntry) {
  let attempts = 0;
  const maxAttempts = 60; // 30 minutes max
  
  const interval = setInterval(async () => {
    attempts++;
    log(`Polling VidIQ job status (attempt ${attempts}/${maxAttempts})...`);
    
    try {
      const response = await client.callTool({
        name: 'vidiq_job_poll',
        arguments: { mcpJobId: runEntry.mcpJobId }
      });
      
      const responseData = typeof response === 'string' ? JSON.parse(response) : response;
      const job = responseData.status ? responseData : JSON.parse(responseData.content[0].text);
      
      log(`Job status: ${job.status}`);
      
      if (job.status === 'completed') {
        clearInterval(interval);
        await client.close();
        log('VidIQ job completed successfully. Parsing clips.');
        
        // Extract clip URLs from result
        // Assuming result contains clips in an array, e.g., job.result.clips
        const clips = job.result?.clips || [];
        if (clips.length === 0) {
          failRun(runEntry, 'Completed job returned 0 clips.');
          return;
        }
        
        runEntry.status = 'downloading';
        runEntry.clips = clips.map((c, i) => ({
          title: c.title || `Clip ${i + 1}`,
          downloadUrl: c.downloadUrl || c.videoUrl || c.url,
          status: 'pending'
        }));
        saveConfig();
        
        if (bot && config.telegram_chat_id) {
          bot.telegram.sendMessage(config.telegram_chat_id, `✅ VidIQ found ${clips.length} clips! Downloading and preparing uploads...`);
        }
        
        processClipsAndUpload(runEntry);
        
      } else if (job.status === 'failed' || job.status === 'expired') {
        clearInterval(interval);
        await client.close();
        failRun(runEntry, `VidIQ job failed or expired. Status: ${job.status}`);
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        await client.close();
        failRun(runEntry, 'VidIQ job timed out after 30 minutes.');
      }
      
    } catch (e) {
      log(`Polling error: ${e.message}`);
    }
  }, 30000); // Poll every 30 seconds
}

async function processClipsAndUpload(runEntry) {
  try {
    const tempDir = path.join(__dirname, 'temp', runEntry.id);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Take the top 5 clips
    const clipsToUpload = runEntry.clips.slice(0, 5);
    log(`Downloading and uploading top ${clipsToUpload.length} clips.`);
    
    if (!hasYoutubeAuth()) {
      failRun(runEntry, 'YouTube accounts is not authenticated. Cannot upload.');
      return;
    }
    
    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });
    
    // Space out uploads by 3 hours starting from now + 10 mins
    const baseDate = new Date();
    baseDate.setMinutes(baseDate.getMinutes() + 10);
    
    for (let i = 0; i < clipsToUpload.length; i++) {
      const clip = clipsToUpload[i];
      clip.status = 'downloading';
      saveConfig();
      
      const fileName = `clip_${i}.mp4`;
      const filePath = path.join(tempDir, fileName);
      
      log(`Downloading clip ${i}: ${clip.downloadUrl}`);
      const writer = fs.createWriteStream(filePath);
      const response = await axios({
        url: clip.downloadUrl,
        method: 'GET',
        responseType: 'stream'
      });
      response.data.pipe(writer);
      
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      
      clip.status = 'uploading';
      saveConfig();
      
      // Calculate scheduling time
      const publishDate = new Date(baseDate.getTime() + i * 3 * 60 * 60 * 1000);
      const publishTimeString = publishDate.toISOString();
      
      log(`Uploading clip ${i} scheduled at ${publishTimeString}`);
      
      const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: {
            title: `${clip.title.substring(0, 70)} #Shorts`,
            description: `${clip.title}\n\nGenerated automatically via VidIQ.\n#Shorts #youtube #trending`,
            categoryId: '22' // People & Blogs
          },
          status: {
            privacyStatus: 'private', // Must be private/unlisted to schedule
            publishAt: publishTimeString,
            selfDeclaredMadeForKids: false
          }
        },
        media: {
          body: fs.createReadStream(filePath)
        }
      });
      
      log(`Uploaded clip ${i} successfully. Video ID: ${res.data.id}`);
      clip.status = 'completed';
      clip.videoId = res.data.id;
      clip.scheduledAt = publishTimeString;
      saveConfig();
      
      // Clean up local file
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    
    // Clean up temp directory
    try { fs.rmdirSync(tempDir); } catch (_) {}
    
    runEntry.status = 'completed';
    config.state = 'idle';
    saveConfig();
    
    if (bot && config.telegram_chat_id) {
      bot.telegram.sendMessage(config.telegram_chat_id, 
        '🎉 **Workflow Completed!**\n\n' +
        `Top ${clipsToUpload.length} clips have been downloaded, uploaded, and scheduled to YouTube Shorts.\n\n` +
        `Check the dashboard to view scheduled links.`
      );
    }
    
  } catch (e) {
    log(`Uploading process failed: ${e.message}`);
    failRun(runEntry, `Uploading failed: ${e.message}`);
  }
}

function failRun(runEntry, reason) {
  log(`Run Failed: ${reason}`);
  runEntry.status = 'failed';
  runEntry.error = reason;
  config.state = 'idle';
  saveConfig();
  
  if (bot && config.telegram_chat_id) {
    bot.telegram.sendMessage(config.telegram_chat_id, `❌ **Automation Failed**\nReason: ${reason}`);
  }
}

// API Endpoints
app.get('/api/status', (req, res) => {
  res.json({
    state: config.state,
    last_run: config.last_run,
    daily_schedule_time: config.daily_schedule_time,
    telegram_connected: !!config.telegram_token && !!config.telegram_chat_id,
    youtube_connected: hasYoutubeAuth(),
    history: config.history.slice(0, 10), // return last 10 runs
    logs: config.logs.slice(-50) // return last 50 logs
  });
});

app.post('/api/config', (req, res) => {
  const { telegram_token, telegram_chat_id, vidiq_api_key, daily_schedule_time } = req.body;
  
  const tokenChanged = telegram_token && telegram_token !== config.telegram_token;
  
  if (telegram_token !== undefined) config.telegram_token = telegram_token;
  if (telegram_chat_id !== undefined) config.telegram_chat_id = telegram_chat_id;
  if (vidiq_api_key !== undefined) config.vidiq_api_key = vidiq_api_key;
  if (daily_schedule_time !== undefined) config.daily_schedule_time = daily_schedule_time;
  
  saveConfig();
  log('Configuration updated via API.');
  
  if (tokenChanged) {
    log('Telegram token changed. Restarting bot client.');
    if (bot) {
      try { bot.stop(); } catch (_) {}
    }
    initTelegramBot();
  }
  
  res.json({ success: true });
});

app.post('/api/trigger', (req, res) => {
  const { url, prompt } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }
  
  if (config.state !== 'idle') {
    return res.status(400).json({ error: 'System is currently busy.' });
  }
  
  handleTriggerInput(`${url} | ${prompt || ''}`, null);
  res.json({ success: true });
});

// YouTube Authentication Endpoints
app.get('/api/auth/youtube', (req, res) => {
  if (!oauth2Client) {
    return res.status(500).json({ error: 'YouTube client is not initialized. Please ensure client_secrets.json is present.' });
  }
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
    prompt: 'consent'
  });
  
  res.json({ url: authUrl });
});

app.get('/api/auth/youtube/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('OAuth callback is missing authorization code.');
  }
  
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(oauthTokenPath, JSON.stringify(tokens, null, 2), 'utf8');
    log('YouTube authorization token successfully exchanged and saved.');
    res.send('<html><body><h3>Authorization Successful!</h3><p>You can close this tab and return to the dashboard.</p><script>setTimeout(() => window.close(), 3000)</script></body></html>');
  } catch (e) {
    log('Error exchanging OAuth token: ' + e.message);
    res.status(500).send('OAuth authentication failed: ' + e.message);
  }
});

app.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
});
