import express from 'express';
import { Telegraf } from 'telegraf';
import { google } from 'googleapis';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import https from 'https';
import http from 'http';
import { setGlobalDispatcher, Agent } from 'undici';

// Configure global undici dispatcher with disabled keep-alive
// This prevents connection reset (Premature close) issues in Node's native fetch
try {
  const undiciAgent = new Agent({
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1
  });
  setGlobalDispatcher(undiciAgent);
} catch (err) {
  console.error('[startup] Failed to set global undici dispatcher:', err.message);
}

import {
  loadToolRegistry,
  toolCount,
  getToolInfo,
  summarizeTools,
  callTool,
  parseKvArgs,
  getTrendingVideos,
  rankVideos,
  getOutliers,
  generateClips,
  pollJob,
  formatToolResult,
  formatToolSchema
} from './vidiq.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const app = express();
app.set('trust proxy', true);
app.use(express.json());

try {
  const n = loadToolRegistry();
  console.log(`[startup] VidIQ MCP tool registry loaded: ${n} tools.`);
} catch (e) {
  console.error(`[startup] Failed to load tool registry: ${e.message}`);
  console.error('[startup] Run `node discover_http.mjs` to (re)generate vidiq_tools.json.');
}

const configPath = path.join(__dirname, 'config.json');
let config = {
  telegram_token: '',
  telegram_chat_id: '',
  daily_schedule_time: '09:00',
  state: 'idle',
  automation_paused: false,
  history: [],
  logs: [],
  viral_feed: [],
  viral_picks: [],
  viral_summary_message_id: null,
  vidiq_default_prompt: 'Highlight the most viral and engaging moments that work as standalone YouTube Shorts. Add mirroring, hue shifting, zooming, and pitch shifting every 10-15 seconds so the video stays the same but looks slightly different. If the video doesn\'t have a human voice or sounds, don\'t use subtitles.',
  viral_filters: {},
  niche_override: null,
  stop_requested: false,
  schedule_passes: [],
  clip_count: null,
  video_stats: [],
  pending_preview: null
};

function loadConfig() {
  if (fs.existsSync(configPath)) {
    try {
      config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (e) {
      log('Error reading config.json: ' + e.message);
    }
  }
  if (process.env.TELEGRAM_TOKEN) config.telegram_token = process.env.TELEGRAM_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) config.telegram_chat_id = process.env.TELEGRAM_CHAT_ID;
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
  const entry = `[${new Date().toISOString()}] ${msg}`;
  console.log(entry);
  config.logs.push(entry);
  if (config.logs.length > 200) config.logs.shift();
  saveConfig();
}

// === YouTube OAuth (kept for the upload flow) ===

const clientSecretsPath = path.join(__dirname, 'client_secrets.json');
let oauth2Client = null;
let youtubeRedirectUri = '';

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
    log('YouTube credentials missing. Set YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET or provide client_secrets.json. Uploads disabled.');
    return;
  }

  try {
    if (!redirectUri && process.env.RAILWAY_PUBLIC_DOMAIN) {
      redirectUri = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/auth/youtube/callback`;
    }
    youtubeRedirectUri = redirectUri || `http://localhost:${PORT}/api/auth/youtube/callback`;
    oauth2Client = new google.auth.OAuth2(clientId, clientSecret, youtubeRedirectUri);

    // Disable keepAlive on the transporter to avoid the "Premature close" socket reuse issue in Node.js
    const httpsAgent = new https.Agent({ keepAlive: false });
    const httpAgent = new http.Agent({ keepAlive: false });
    oauth2Client.transporter.defaults = {
      ...(oauth2Client.transporter.defaults || {}),
      httpsAgent,
      httpAgent
    };

    // Load tokens from config.json (survives Railway deploys)
    if (config.youtube_tokens && config.youtube_tokens.access_token) {
      oauth2Client.setCredentials(config.youtube_tokens);
      log('YouTube OAuth credentials loaded from config.');
    }
  } catch (e) {
    log('Failed to initialize YouTube auth: ' + e.message);
  }
}

initYoutubeAuth();

function hasYoutubeAuth() {
  return oauth2Client && oauth2Client.credentials && oauth2Client.credentials.access_token !== undefined;
}

app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  const telegramOnline = !!config.telegram_token;
  const ytAuth = hasYoutubeAuth();
  const tools = toolCount();
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>VidIQ Telegram Bot</title>
<style>
body{font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.5}
h1{margin:0 0 8px}
.muted{color:#666;font-size:14px}
.card{border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin:16px 0}
.row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #f0f0f0}
.row:last-child{border:0}
.ok{color:#0a7d27;font-weight:600}
.no{color:#b00020;font-weight:600}
code{background:#f5f5f5;padding:2px 6px;border-radius:4px;font-size:13px}
</style></head><body>
<h1>VidIQ Telegram Bot</h1>
<p class="muted">This service is a Telegram bot backend, not a website. It has no UI. Interact with it through Telegram.</p>

<div class="card">
  <div class="row"><span>Telegram bot</span><span class="${telegramOnline ? 'ok' : 'no'}">${telegramOnline ? 'online' : 'OFFLINE (no TELEGRAM_TOKEN)'}</span></div>
  <div class="row"><span>YouTube auth</span><span class="${ytAuth ? 'ok' : 'no'}">${ytAuth ? 'authorized' : 'needs /api/auth/youtube'}</span></div>
  <div class="row"><span>VidIQ MCP tools</span><span class="ok">${tools} loaded</span></div>
  <div class="row"><span>Daily schedule</span><span>${escapeHtml(config.daily_schedule_time)}</span></div>
  <div class="row"><span>Registered chat</span><span>${escapeHtml(config.telegram_chat_id || '(none — send /start to the bot)')}</span></div>
</div>

<div class="card">
  <div class="row"><span><code>GET /health</span><span>JSON status</code></span></div>
  <div class="row"><span><code>GET /api/auth/youtube</code></span><span>start YouTube OAuth</span></div>
  <div class="row"><span><code>GET /api/auth/youtube/callback?code=…</code></span><span>OAuth redirect target</span></div>
</div>
</body></html>`);
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    telegram: !!config.telegram_token,
    youtube: hasYoutubeAuth(),
    vidiq_tools: toolCount(),
    state: config.state,
    chat_id: config.telegram_chat_id || null,
    uptime_sec: Math.round(process.uptime())
  });
});

app.get('/api/auth/youtube', (req, res) => {
  if (!oauth2Client) return res.status(500).send(`YouTube client not initialized. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET env vars first.`);
  
  // Dynamically set redirect URI based on the request host/protocol if not explicitly overridden in environment
  if (!process.env.YOUTUBE_REDIRECT_URI) {
    const proto = req.protocol;
    const host = req.get('host');
    youtubeRedirectUri = `${proto}://${host}/api/auth/youtube/callback`;
    oauth2Client.redirectUri = youtubeRedirectUri;
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
    prompt: 'consent'
  });
  res.send(`<html><body>
    <h3>YouTube Authorization</h3>
    <p>Click below to authorize. Make sure this redirect URI:</p>
    <pre>${youtubeRedirectUri}</pre>
    <p>is listed in <a href="https://console.cloud.google.com/apis/credentials">Google Cloud Console</a> as an Authorized Redirect URI.</p>
    <p><a href="${authUrl}">Continue to Google →</a></p>
  </body></html>`);
});

app.get('/api/auth/youtube/callback', async (req, res) => {
  const code = req.query.code;
  const error = req.query.error;
  if (error) {
    log(`YouTube OAuth denied: ${error}`);
    return res.send(`<html><body><h3>Authorization Denied</h3><p>Google returned: ${error}</p><p>Try again at <a href="/api/auth/youtube">/api/auth/youtube</a>.</p></body></html>`);
  }
  if (!oauth2Client) {
    log('YouTube OAuth callback hit but client not initialized.');
    return res.status(500).send('YouTube client not initialized. Check YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET env vars.');
  }

  // Dynamically set redirect URI based on the request host/protocol if not explicitly overridden in environment
  if (!process.env.YOUTUBE_REDIRECT_URI) {
    const proto = req.protocol;
    const host = req.get('host');
    youtubeRedirectUri = `${proto}://${host}/api/auth/youtube/callback`;
    oauth2Client.redirectUri = youtubeRedirectUri;
  }

  if (!code) {
    log('YouTube OAuth callback missing authorization code. Query: ' + JSON.stringify(req.query));
    return res.status(400).send(`Missing authorization code. Make sure the redirect URI below matches what's in <a href="https://console.cloud.google.com/apis/credentials">Google Cloud Console</a>:<br><br><code>${youtubeRedirectUri}</code>`);
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    config.youtube_tokens = tokens;
    saveConfig();
    log('YouTube authorization token saved to config.');
    res.send('<html><body><h3>Authorization Successful!</h3><p>You can close this tab. Return to the bot.</p><script>setTimeout(() => window.close(), 3000)</script></body></html>');
  } catch (e) {
    log('OAuth exchange failed: ' + e.message);
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

// === Clipping pipeline (used by /clip and the viral run) ===

function startClippingPipeline(runEntry, url, prompt) {
  return new Promise((resolve) => {
    runEntry._resolve = resolve;
    runClippingPipeline(runEntry, url, prompt);
  });
}

async function runClippingPipeline(runEntry, url, prompt) {
  if (config.stop_requested) { abortRun(runEntry); return; }
  log(`Submitting clipping job for URL: ${url}`);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await generateClips(url, prompt);
      const data = r.data || {};
      const mcpJobId = data.mcpJobId || data.jobId || (data.content && data.content[0] && JSON.parse(data.content[0].text).mcpJobId);
      if (!mcpJobId) throw new Error(`No mcpJobId in generate_clips response: ${JSON.stringify(data).slice(0, 200)}`);

      runEntry.mcpJobId = mcpJobId;
      saveConfig();
      if (bot && config.telegram_chat_id) {
        bot.telegram.sendMessage(config.telegram_chat_id, `⏳ VidIQ processing started. Job ID: \`${mcpJobId}\`. Polling for completion.`);
      }
      pollVidIQJob(runEntry);
      return;
    } catch (e) {
      lastErr = e;
      log(`VidIQ submission attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  failRun(runEntry, `VidIQ submission failed after 3 attempts: ${lastErr.message}`);
}

async function pollVidIQJob(runEntry) {
  let attempts = 0;
  const maxAttempts = 60;
  const interval = setInterval(async () => {
    if (config.stop_requested) { clearInterval(interval); abortRun(runEntry); return; }
    attempts++;
    log(`Polling VidIQ job ${runEntry.mcpJobId} (attempt ${attempts}/${maxAttempts})…`);
    let pollingRetries = 0;
    while (pollingRetries < 3) {
      try {
        const r = await pollJob(runEntry.mcpJobId);
        const job = r.data || {};
        log(`Job status: ${job.status}`);
        if (job.status === 'completed') {
          clearInterval(interval);
          log('VidIQ job completed.');
          const clips = (job.result && job.result.clips) || job.clips || [];
          if (!clips.length) {
            failRun(runEntry, 'Job completed but returned 0 clips.');
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
            await bot.telegram.sendMessage(config.telegram_chat_id, `✅ VidIQ produced ${clips.length} clips. Downloading and uploading…`);
          }
          processClipsAndUpload(runEntry);
        } else if (job.status === 'failed' || job.status === 'expired') {
          clearInterval(interval);
          failRun(runEntry, `Job ${job.status}.`);
        } else if (attempts >= maxAttempts) {
          clearInterval(interval);
          failRun(runEntry, 'Timed out after 30 minutes.');
        }
        break;
      } catch (e) {
        pollingRetries++;
        log(`Polling error (attempt ${pollingRetries}): ${e.message}`);
        if (pollingRetries >= 3) break;
        await sleep(1000 * pollingRetries);
      }
    }
  }, 30000);
}

async function processClipsAndUpload(runEntry) {
  try {
    if (!hasYoutubeAuth()) {
      failRun(runEntry, 'YouTube not authenticated. Cannot upload.');
      return;
    }
    const tempDir = path.join(__dirname, 'temp', runEntry.id);
    fs.mkdirSync(tempDir, { recursive: true });
    const maxClips = config.clip_count || 5;
    const clips = runEntry.clips.slice(0, maxClips);
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const baseDate = new Date();
    baseDate.setMinutes(baseDate.getMinutes() + 10);

    for (let i = 0; i < clips.length; i++) {
      if (config.stop_requested) { abortRun(runEntry, tempDir); return; }
      const clip = clips[i];
      clip.status = 'downloading';
      saveConfig();
      const filePath = path.join(tempDir, `clip_${i}.mp4`);
      const writer = fs.createWriteStream(filePath);
      let dlRetries = 0;
      while (dlRetries < 3) {
        try {
          const res = await axios({ url: clip.downloadUrl, method: 'GET', responseType: 'stream' });
          res.data.pipe(writer);
          await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
          break;
        } catch (e) {
          dlRetries++;
          log(`Download attempt ${dlRetries} failed for clip ${i}: ${e.message}`);
          if (dlRetries >= 3) throw e;
          await sleep(1000 * dlRetries);
        }
      }

      clip.status = 'uploading';
      saveConfig();
      const publishAt = new Date(baseDate.getTime() + i * 3 * 60 * 60 * 1000).toISOString();
      let upRetries = 0;
      let up;
      while (upRetries < 3) {
        try {
          up = await youtube.videos.insert({
            part: 'snippet,status',
            requestBody: {
              snippet: {
                title: `${clip.title.substring(0, 70)} #Shorts`,
                description: `${clip.title}\n\nClip from: ${runEntry.sourceVideo?.title || clip.title}\nChannel: ${runEntry.sourceVideo?.channelTitle || 'Unknown'}\nOriginal: ${runEntry.sourceVideo?.url || ''}\n\n#Shorts #youtube #trending`,
                categoryId: '22'
              },
              status: { privacyStatus: 'private', publishAt, selfDeclaredMadeForKids: false }
            },
            media: { body: fs.createReadStream(filePath) }
          });
          break;
        } catch (e) {
          upRetries++;
          log(`Upload attempt ${upRetries} failed for clip ${i}: ${e.message}`);
          if (upRetries >= 3) throw e;
          await sleep(1000 * upRetries);
        }
      }
      clip.status = 'completed';
      clip.videoId = up.data.id;
      clip.scheduledAt = publishAt;
      saveConfig();
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    try { fs.rmdirSync(tempDir); } catch (_) {}

    config.video_stats.push({
      videoId: runEntry.url,
      clipCount: clips.length,
      scheduledAt: new Date().toISOString(),
      niche: config.niche_override || 'general',
      sourceUrl: runEntry.url,
      clips: clips.map(c => ({ title: c.title, videoId: c.videoId, scheduledAt: c.scheduledAt }))
    });
    saveConfig();

    runEntry.status = 'completed';
    config.state = 'idle';
    saveConfig();
    if (bot && config.telegram_chat_id) {
      await bot.telegram.sendMessage(config.telegram_chat_id, `🎉 Workflow done — ${clips.length} Shorts scheduled.`);
    }
    if (runEntry._resolve) { const r = runEntry._resolve; runEntry._resolve = null; r(); }
  } catch (e) {
    log(`Uploading failed: ${e.message}`);
    failRun(runEntry, `Uploading failed: ${e.message}`);
  }
}

function failRun(runEntry, reason) {
  log(`Run failed: ${reason}`);
  runEntry.status = 'failed';
  runEntry.error = reason;
  config.state = 'idle';
  saveConfig();
  if (bot && config.telegram_chat_id) {
    bot.telegram.sendMessage(config.telegram_chat_id, `❌ Automation failed: ${reason}`);
  }
  if (runEntry._resolve) { const r = runEntry._resolve; runEntry._resolve = null; r(); }
}

// === Daily cron: viral search at 09:00 (configurable) ===

setInterval(() => {
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (t === config.daily_schedule_time && config.state === 'idle' && !config.automation_paused) {
    triggerDailyViralSearch();
  }
  if (config.schedule_passes && config.state === 'idle' && !config.automation_paused) {
    for (const pass of config.schedule_passes) {
      if (t === pass.time) {
        triggerDailyViralSearch(pass.niche || null, pass.clipCount || null);
      }
    }
  }
}, 60000);

let viral_display_offset = 0;

async function triggerDailyViralSearch(nicheOverride, clipCountOverride) {
  if (!bot || !config.telegram_chat_id) {
    log('Daily viral skipped: no bot/chat.');
    return;
  }
  config.state = 'fetching_viral';
  config.viral_feed = [];
  config.viral_picks = [];
  viral_display_offset = 0;
  config.niche_override = nicheOverride || config.niche_override;
  config.clip_count = clipCountOverride !== null && clipCountOverride !== undefined ? clipCountOverride : config.clip_count;
  saveConfig();
  log('Daily viral search triggered.' + (config.niche_override ? ` (niche: ${config.niche_override})` : ''));
  try {
    const filters = { ...(config.viral_filters || {}) };
    if (config.niche_override) filters.keyword = config.niche_override;
    const raw = await getTrendingVideos(filters);
    if (!raw || raw.length < 2) {
      config.state = 'idle';
      saveConfig();
      await bot.telegram.sendMessage(config.telegram_chat_id, '⚠️ VidIQ returned too few trending videos. Skipping.');
      return;
    }
    const feed = rankVideos(raw);
    config.viral_feed = feed;
    config.state = 'waiting_for_viral_pick';
    saveConfig();
    await sendViralPicker(feed, 0);
  } catch (e) {
    log(`Daily viral failed: ${e.message}`);
    config.state = 'idle';
    saveConfig();
    if (bot && config.telegram_chat_id) {
      await bot.telegram.sendMessage(config.telegram_chat_id, `❌ Daily viral failed: ${e.message}\nBot idle.`);
    }
  }
}

function escapeMarkdown(s) {
  return String(s).replace(/[_*`\[\]()~>#+\-=|{}.!\\]/g, '\\$&');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendViralPicker(feed, startIndex = 0) {
  const batch = feed.slice(startIndex, startIndex + 5);
  const total = feed.length;
  for (const video of batch) {
    const stats = video.viewCount != null ? ` • ${Number(video.viewCount).toLocaleString()} views` : '';
    const caption = `*${video.index + 1}.* ${escapeMarkdown(video.title)}\n_${escapeMarkdown(video.channelTitle)}_${stats}\n${video.url}`;
    try {
      const sent = await bot.telegram.sendPhoto(config.telegram_chat_id, video.thumbnail, {
        caption: caption.substring(0, 1024),
        parse_mode: 'Markdown'
      });
      video.messageId = sent.message_id;
    } catch (e) {
      log(`Photo send failed for ${video.url}: ${e.message}`);
      const sent = await bot.telegram.sendMessage(config.telegram_chat_id, caption, { parse_mode: 'Markdown' });
      video.messageId = sent.message_id;
    }
    saveConfig();
  }
  const end = Math.min(startIndex + 5, total);
  const summary = await bot.telegram.sendMessage(config.telegram_chat_id,
    `🎬 *Pick 2 of ${total}* (showing ${startIndex + 1}-${end})\n\nReply \`.\` to any video above to pick it. After 2 picks, the pipeline starts automatically.\nUse \`/donnie refresh\` for the next batch.`,
    { parse_mode: 'Markdown' });
  config.viral_summary_message_id = summary.message_id;
  saveConfig();
}

function handleViralReplyPick(ctx, repliedToMessageId) {
  const match = (config.viral_feed || []).find(v => v.messageId === repliedToMessageId);
  if (!match) {
    return ctx.reply("That message isn't part of today's viral run. Use /donnie to fetch a fresh feed.");
  }
  if ((config.viral_picks || []).includes(match.index)) {
    return ctx.reply(`Already picked #${match.index + 1}. Reply \`.\` to a different video.`);
  }
  config.viral_picks = config.viral_picks || [];
  if (config.viral_picks.length >= 2) return ctx.reply('All picks in. Pipeline should be running.');
  config.viral_picks.push(match.index);
  saveConfig();
  ctx.reply(`✓ Picked #${match.index + 1} — ${escapeMarkdown(match.title)} (${config.viral_picks.length}/2).`);
  if (config.viral_summary_message_id) {
    const total = (config.viral_feed || []).length;
    const next = config.viral_picks.length === 2
      ? `🎬 *Pick 2 of ${total}*\n\n✓ 2/2 picked. Reply \`y\` to approve or \`n\` to cancel.`
      : `🎬 *Pick 2 of ${total}*\n\n✓ 1/2 picked. Reply \`.\` to another video, or use \`/donnie refresh\` for the next batch.`;
    bot.telegram.editMessageText(config.telegram_chat_id, config.viral_summary_message_id, null, next, { parse_mode: 'Markdown' }).catch(() => {});
  }
  if (config.viral_picks.length === 2) {
    config.pending_preview = {
      picks: [...config.viral_picks],
      feed: [...(config.viral_feed || [])]
    };
    saveConfig();
    const previewLines = config.viral_picks.map(idx => {
      const v = config.viral_feed[idx];
      return `  ${idx + 1}. ${v.title}`;
    });
    ctx.reply(
      `📋 *Preview — 2 picks ready:*\n${previewLines.join('\n')}\n\nReply \`y\` to approve and start, or \`n\` to cancel.`,
      { parse_mode: 'Markdown' }
    );
  }
}

async function runViralPicks() {
  const picks = [...config.viral_picks];
  const summary = { startedAt: new Date().toISOString(), picks: [], results: [] };
  for (let i = 0; i < picks.length; i++) {
    const idx = picks[i];
    const video = config.viral_feed[idx];
    if (!video) continue;
    config.state = 'vidiq_processing';
    config.last_run = new Date().toISOString();
    saveConfig();
    const runEntry = {
      id: Date.now().toString() + '_' + i,
      timestamp: config.last_run,
      url: video.url,
      title: video.title,
      source: 'viral_pick',
      prompt: config.vidiq_default_prompt,
      status: 'processing',
      clips: [],
      sourceVideo: { title: video.title, channelTitle: video.channelTitle, url: video.url, viewCount: video.viewCount }
    };
    config.history.unshift(runEntry);
    saveConfig();
    if (bot && config.telegram_chat_id) {
      await bot.telegram.sendMessage(config.telegram_chat_id, `▶️ Pick ${i + 1}/${picks.length}: _${escapeMarkdown(video.title)}_`);
    }
    try {
      await startClippingPipeline(runEntry, video.url, config.vidiq_default_prompt);
      summary.results.push({ index: idx, status: runEntry.status });
    } catch (e) {
      log(`Viral pick ${i} failed: ${e.message}`);
      summary.results.push({ index: idx, status: 'failed', error: e.message });
    }
  }
  config.state = 'idle';
  config.viral_feed = [];
  config.viral_picks = [];
  saveConfig();
  log(`Viral run complete: ${JSON.stringify(summary)}`);
  if (bot && config.telegram_chat_id) {
    const ok = summary.results.filter(r => r.status === 'completed').length;
    await bot.telegram.sendMessage(config.telegram_chat_id, `🏁 Viral run done — ${ok}/${picks.length} videos completed.`);
  }
}

// === Manual clip command (escape hatch) ===

function handleTriggerInput(text, ctx) {
  const parts = text.split('|');
  const url = parts[0]?.trim();
  const prompt = parts[1]?.trim() || 'Highlight key highlights';
  if (!url || !url.startsWith('http')) {
    if (ctx) ctx.reply('⚠️ Invalid URL. Example: /clip https://youtube.com/watch?v=xxx | Focus on the funniest parts');
    return;
  }
  if (config.state !== 'idle') {
    if (ctx) ctx.reply(`System is busy (${config.state}). Wait for it to finish.`);
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
    source: 'manual',
    status: 'processing',
    clips: []
  };
  config.history.unshift(runEntry);
  saveConfig();
  if (ctx) ctx.reply('🚀 Starting clipping job…');
  startClippingPipeline(runEntry, url, prompt);
}

// === Telegram bot ===

let bot;

function initTelegramBot() {
  if (!config.telegram_token) {
    log('Telegram token missing. Bot offline.');
    return;
  }
  try {
    bot = new Telegraf(config.telegram_token);

    bot.start((ctx) => {
      config.telegram_chat_id = String(ctx.chat.id);
      saveConfig();
      log(`Chat registered: ${config.telegram_chat_id}`);
      ctx.reply('Hello! VidIQ AutoClipper is online. Type /help to see commands.');
    });

    bot.command('help', (ctx) => {
      ctx.reply(
        '🤖 *VidIQ AutoClipper — Help*\n\n' +
        '*Basics*\n' +
        '/start — Register this chat.\n' +
        '/status — Show state, last run, YouTube auth, prompt, filters.\n' +
        '/clip `<url> | <prompt>` — Manual clip run on a specific video.\n\n' +
        '*Donnie (viral + VidIQ MCP)*\n' +
        '/donnie — Trigger today\'s viral run (5 trending → pick 2 → clip).\n' +
        '/donnie pause — Pause the daily automation cron.\n' +
        '/donnie resume — Resume the daily automation cron.\n' +
        '/donnie prompt `<text>` — Set the default clip-generation prompt.\n' +
        '/donnie video filter `k=v` — Set viral-search filters (videoFormat, channelCountry, vphMin, etc.).\n' +
        '/donnie filters — Show current viral filters.\n' +
        '/donnie balance — Check VidIQ credits.\n' +
        '/donnie tools — List all 44 VidIQ MCP tools.\n' +
        '/donnie tool `<name> k=v ...` — Call any VidIQ MCP tool directly.\n' +
        '/donnie tool `<name> help` — Show a tool\'s required/optional params.\n\n' +
        '*Shortcuts for common tools*\n' +
        '/donnie trending — Trending now (long-form, default filters).\n' +
        '/donnie trending short — Trending Shorts.\n' +
        '/donnie outliers `<keyword>` — Outlier videos in a niche.\n' +
        '/donnie keyword `<seed>` — Keyword research (vol/comp/related).\n' +
        '/donnie channel `<@handle or UCid>` — Channel stats.\n' +
        '/donnie similar `<niche>` — Similar channels.\n' +
        '/donnie transcript `<videoId>` — Get a video transcript.\n' +
        '/donnie jobs — List your VidIQ jobs.\n' +
        '/donnie schedule `HH:MM` — Set daily schedule time.\n' +
        '/donnie niche `<niche>` — Set niche override (keyword for trending).\n' +
        '/donnie stop — Stop the current run.\n' +
        '/donnie clipcount `<N>` — Max clips per video.\n' +
        '/donnie passes `<time1> [<time2> ...]` — Extra trending passes.\n' +
        '/donnie stats — Show performance stats.\n\n' +
        `Daily schedule: ${config.daily_schedule_time}.\n` +
        'After /donnie sends 5 video photos, reply `.` to 2 of them to pick. The pipeline auto-starts after 2 picks.',
        { parse_mode: 'Markdown' }
      );
    });

    bot.command('status', (ctx) => {
      const lines = [
        `*State:* \`${config.state}\``,
        `*Automation:* ${config.automation_paused ? '⏸ paused' : '▶ running'}`,
        `*Last run:* ${config.last_run || 'never'}`,
        `*YouTube auth:* ${hasYoutubeAuth() ? 'yes' : 'no'}`,
        `*Daily schedule:* ${config.daily_schedule_time}`,
        `*Niche override:* ${config.niche_override || '(none)'}`,
        `*Clip count:* ${config.clip_count || 5}`,
        `*Schedule passes:* ${(config.schedule_passes || []).map(p => p.time).join(', ') || '(none)'}`,
        `*Default prompt:* ${escapeMarkdown(config.vidiq_default_prompt || '(default)')}`,
        `*Viral filters:* ${Object.keys(config.viral_filters || {}).length ? '\\`' + JSON.stringify(config.viral_filters) + '\\`' : '(none)'}`,
        `*VidIQ tools loaded:* ${toolCount()}`,
        `*Recent runs:* ${(config.history || []).length}`
      ];
      ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    bot.command('clip', (ctx) => {
      const args = ctx.message.text.split(' ').slice(1).join(' ');
      if (!args) return ctx.reply('Usage: /clip `<url> | <prompt>`');
      handleTriggerInput(args, ctx);
    });

    // Register ALL commands before the catch-all text handler, otherwise
    // Telegraf routes command messages to bot.on('text') first.
    bot.command('donnie', async (ctx) => {
      try { await handleDonnieCommand(ctx); }
      catch (e) {
        log(`Donnie command error: ${e.message}`);
        ctx.reply(`❌ ${e.message}`);
      }
    });

    bot.on('text', (ctx) => {
      const text = ctx.message.text;
      const replyTo = ctx.message.reply_to_message;
      if (text && text.startsWith('/')) {
        return ctx.reply('Unknown command. Type /help for the full list.');
      }
      if (config.state === 'waiting_for_input') {
        handleTriggerInput(text, ctx);
      } else if (config.state === 'waiting_for_viral_pick') {
        if (text === '.' && replyTo) {
          handleViralReplyPick(ctx, replyTo.message_id);
        } else if (text === '.') {
          ctx.reply('Reply `.` to one of the 5 video messages above, not as a new message.');
        } else if (config.pending_preview && (text.toLowerCase() === 'y' || text.toLowerCase() === 'yes')) {
          config.pending_preview = null;
          saveConfig();
          runViralPicks().catch((e) => {
            log(`runViralPicks crashed: ${e.message}`);
            config.state = 'idle';
            saveConfig();
          });
        } else if (config.pending_preview && (text.toLowerCase() === 'n' || text.toLowerCase() === 'no')) {
          config.viral_picks = [];
          config.pending_preview = null;
          saveConfig();
          ctx.reply('✖ Cancelled. You can pick again or type /donnie for a fresh feed.');
        } else {
          ctx.reply('Pick 2 of the 5 viral videos by replying `.` to them. Type /help for the full command list.');
        }
      } else {
        ctx.reply(`Bot is currently \`${config.state}\`. Use /donnie or /clip. Type /help.`);
      }
    });

    bot.launch();
    log('Telegram bot launched.');
  } catch (e) {
    log('Failed to launch bot: ' + e.message);
  }
}

async function handleDonnieCommand(ctx) {
  const text = ctx.message.text;
  const parts = text.split(' ').slice(1);
  const sub = (parts[0] || '').toLowerCase();

  if (!sub) return triggerDonnieNow(ctx);
  if (sub === 'prompt') return setDonniePrompt(ctx, parts.slice(1).join(' ').trim());
  if (sub === 'video' && (parts[1] || '').toLowerCase() === 'filter') return setDonnieVideoFilter(ctx, parts.slice(2));
  if (sub === 'filters') return showDonnieFilters(ctx);
  if (sub === 'tools') return showAllTools(ctx);
  if (sub === 'tool') return callGenericTool(ctx, parts.slice(1));
  if (sub === 'balance') return callAndShow(ctx, 'vidiq_balance', {});
  if (sub === 'jobs') return callAndShow(ctx, 'vidiq_jobs_list', {});
  if (sub === 'trending') return handleTrendingShortcut(ctx, parts.slice(1));
  if (sub === 'outliers') return callAndShow(ctx, 'vidiq_outliers', await parseOutliersArgs(parts.slice(1)));
  if (sub === 'keyword') return callAndShow(ctx, 'vidiq_keyword_research', { keyword: parts.slice(1).join(' ') || undefined });
  if (sub === 'channel') return handleChannelShortcut(ctx, parts.slice(1));
  if (sub === 'similar') return callAndShow(ctx, 'vidiq_similar_channels', { niche: parts.slice(1).join(' ') });
  if (sub === 'transcript') return callAndShow(ctx, 'vidiq_video_transcript', { videoId: parts[1] });
  if (sub === 'pause') return pauseAutomation(ctx);
  if (sub === 'resume') return resumeAutomation(ctx);
  if (sub === 'schedule') return setDonnieSchedule(ctx, parts.slice(1));
  if (sub === 'niche') return setDonnieNiche(ctx, parts.slice(1));
  if (sub === 'stop') return stopCurrentRun(ctx);
  if (sub === 'clipcount') return setDonnieClipCount(ctx, parts.slice(1));
  if (sub === 'passes') return setDonniePasses(ctx, parts.slice(1));
  if (sub === 'stats') return getDonnieStats(ctx);
  if (sub === 'refresh') return refreshViralFeed(ctx);

  return ctx.reply(
    'Unknown /donnie subcommand.\n\n' +
    'Try /donnie, /donnie pause, /donnie resume, /donnie schedule, /donnie niche, /donnie stop, /donnie clipcount, /donnie passes, /donnie stats, /donnie refresh, /donnie prompt, /donnie video filter, /donnie filters, /donnie tools, /donnie tool `<name>`, /donnie balance, /donnie jobs, or one of the shortcuts (trending, outliers, keyword, channel, similar, transcript). Type /help for the full list.'
  );
}

async function pauseAutomation(ctx) {
  if (config.automation_paused) return ctx.reply('⏸ Already paused.');
  config.automation_paused = true;
  saveConfig();
  log('Automation paused by user.');
  ctx.reply('⏸ Automation paused. Daily cron will not trigger. Use `/donnie resume` to re-enable.', { parse_mode: 'Markdown' });
}

async function resumeAutomation(ctx) {
  if (!config.automation_paused) return ctx.reply('▶ Already running.');
  config.automation_paused = false;
  saveConfig();
  log('Automation resumed by user.');
  ctx.reply('▶ Automation resumed. Daily cron will fire at the next scheduled time.');
}

async function triggerDonnieNow(ctx) {
  if (!config.telegram_chat_id) {
    config.telegram_chat_id = String(ctx.chat.id);
    saveConfig();
  }
  if (config.state !== 'idle') return ctx.reply(`Cannot run now. State: \`${config.state}\`. Wait for current run.`, { parse_mode: 'Markdown' });
  await ctx.reply('🔥 Triggering viral run…');
  triggerDailyViralSearch();
}

async function refreshViralFeed(ctx) {
  const feed = config.viral_feed || [];
  if (feed.length && viral_display_offset + 5 < feed.length) {
    viral_display_offset += 5;
    config.viral_summary_message_id = null;
    saveConfig();
    await ctx.reply(`🔄 Showing next batch (videos ${viral_display_offset + 1}-${Math.min(viral_display_offset + 5, feed.length)} of ${feed.length}).`);
    await sendViralPicker(feed, viral_display_offset);
  } else {
    config.viral_feed = [];
    config.viral_picks = [];
    config.pending_preview = null;
    config.viral_summary_message_id = null;
    viral_display_offset = 0;
    saveConfig();
    await ctx.reply('🔄 No more batches. Fetching fresh feed…');
    triggerDailyViralSearch();
  }
}

function setDonniePrompt(ctx, prompt) {
  if (!prompt) return ctx.reply(`Current default prompt:\n\n${config.vidiq_default_prompt}`);
  config.vidiq_default_prompt = prompt;
  saveConfig();
  ctx.reply(`✓ Default prompt updated:\n\n${prompt}`);
}

function setDonnieVideoFilter(ctx, pairs) {
  if (!pairs.length) return showDonnieFilters(ctx);
  for (const raw of pairs) {
    const eq = raw.indexOf('=');
    if (eq <= 0) return ctx.reply(`Invalid filter: "${raw}". Use key=value (e.g., videoFormat=short, channelCountry=US, vphMin=100).`);
    config.viral_filters = config.viral_filters || {};
    config.viral_filters[raw.substring(0, eq).trim()] = raw.substring(eq + 1).trim();
  }
  saveConfig();
  ctx.reply(`✓ Viral filters updated:\n${formatFilters()}`);
}

function showDonnieFilters(ctx) {
  const f = config.viral_filters || {};
  if (!Object.keys(f).length) return ctx.reply('No viral filters set. Example: /donnie video filter videoFormat=short channelCountry=US');
  ctx.reply(`Current viral filters:\n${formatFilters()}`);
}

function formatFilters() {
  const f = config.viral_filters || {};
  return Object.keys(f).length ? Object.entries(f).map(([k, v]) => `  ${k} = ${v}`).join('\n') : '  (none)';
}

function showAllTools(ctx) {
  ctx.reply(`*VidIQ MCP Tools (${toolCount()})*\n\n${summarizeTools()}\n\nCall any tool with: \`/donnie tool <name> key=value ...\`\nShow params: \`/donnie tool <name> help\``, { parse_mode: 'Markdown' });
}

async function callGenericTool(ctx, args) {
  if (!args.length) return ctx.reply('Usage: /donnie tool `<name> key=value [key2=value2 ...]`\nExample: /donnie tool vidiq_youtube_search query=ai');
  const name = args[0];
  if (args[1] === 'help') return ctx.reply(formatToolSchema(name), { parse_mode: 'Markdown' });
  let kv;
  try { kv = parseKvArgs(args.slice(1)); }
  catch (e) { return ctx.reply(`❌ ${e.message}`); }
  return callAndShow(ctx, name, kv);
}

async function callAndShow(ctx, name, args) {
  await ctx.replyWithChatAction('typing');
  try {
    const { data } = await callTool(name, args);
    const text = formatToolResult(name, data);
    if (text.length <= 4000) {
      await ctx.reply(text, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(text.substring(0, 4000), { parse_mode: 'Markdown' });
      await ctx.reply(`…(${text.length} chars total) Use \`/donnie tool ${name}\` to call again with different args.`);
    }
  } catch (e) {
    await ctx.reply(`❌ ${e.message}`);
  }
}

async function handleTrendingShortcut(ctx, args) {
  const filters = { ...(config.viral_filters || {}) };
  for (const tok of args) {
    if (tok === 'short') filters.videoFormat = 'short';
    else if (tok === 'long') filters.videoFormat = 'long';
    else {
      try { Object.assign(filters, parseKvArgs([tok])); }
      catch (e) { return ctx.reply(`❌ ${e.message}`); }
    }
  }
  return callAndShow(ctx, 'vidiq_trending_videos', filters);
}

async function parseOutliersArgs(args) {
  if (!args.length) throw new Error('Usage: /donnie outliers `<keyword> [k=v ...]`');
  const out = { keyword: args[0] };
  try { Object.assign(out, parseKvArgs(args.slice(1))); } catch (_) {}
  return out;
}

async function handleChannelShortcut(ctx, args) {
  if (!args.length) return ctx.reply('Usage: /donnie channel `<@handle or UCid>`');
  const id = args[0].replace(/^@/, '');
  const kv = {};
  try { Object.assign(kv, parseKvArgs(args.slice(1))); } catch (_) {}
  return callAndShow(ctx, 'vidiq_channel_stats', { channelId: id, ...kv });
}

// === New feature functions ===

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function setDonnieSchedule(ctx, args) {
  const time = (args || []).join('').trim();
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return ctx.reply('Usage: /donnie schedule `HH:MM` (24h format).');
  config.daily_schedule_time = time;
  saveConfig();
  ctx.reply(`✓ Daily schedule set to ${time}.`);
}

function setDonnieNiche(ctx, args) {
  const niche = (args || []).join(' ').trim();
  config.niche_override = niche || null;
  saveConfig();
  ctx.reply(niche ? `✓ Niche override set to "${niche}".` : '✓ Niche override cleared. Trending will use default filters.');
}

async function stopCurrentRun(ctx) {
  config.stop_requested = true;
  saveConfig();
  const run = (config.history || []).find(e => e.status === 'processing');
  if (run) {
    failRun(run, 'Manually stopped by user');
  } else {
    config.state = 'idle';
    saveConfig();
  }
  ctx.reply('⏹ Stop requested. The current run will abort at the next check point.');
}

function setDonnieClipCount(ctx, args) {
  const n = parseInt((args || [])[0], 10);
  if (isNaN(n) || n < 1 || n > 20) return ctx.reply('Usage: /donnie clipcount `<1-20>`.');
  config.clip_count = n;
  saveConfig();
  ctx.reply(`✓ Max clips per video set to ${n}.`);
}

function setDonniePasses(ctx, args) {
  const times = (args || []).join(' ').trim().split(/\s+/).filter(Boolean);
  if (!times.length) return ctx.reply('Usage: /donnie passes `<HH:MM> [<HH:MM> ...]`.\nExample: /donnie passes 14:00 20:00');
  for (const t of times) {
    if (!/^\d{2}:\d{2}$/.test(t)) return ctx.reply(`Invalid time: "${t}". Use HH:MM format.`);
  }
  config.schedule_passes = times.map(t => ({ time: t }));
  saveConfig();
  ctx.reply(`✓ Schedule passes set: ${times.join(', ')}.`);
}

function getDonnieStats(ctx) {
  const stats = config.video_stats || [];
  if (!stats.length) return ctx.reply('No stats yet. Runs will be tracked after each completion.');

  const ok = stats.filter(s => s.videoId);
  const totalClips = ok.reduce((sum, s) => sum + (s.clipCount || 0), 0);
  const niches = [...new Set(ok.map(s => s.niche).filter(Boolean))];

  const lines = [
    `*Donnie Stats*`,
    `Total runs: ${stats.length}`,
    `Successful: ${ok.length}`,
    `Total clips generated: ${totalClips}`,
    `Niches used: ${niches.join(', ') || '(default)'}`,
    ``,
    `*Last 5 runs:*`
  ];

  for (const s of stats.slice(-5).reverse()) {
    lines.push(`  ${s.scheduledAt?.substring(0, 10) || '?'} — ${s.niche || 'default'} — ${s.clipCount || 0} clips${s.videoId ? ' ✓' : ' ✗'}`);
  }

  ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

initTelegramBot();

app.listen(PORT, () => {
  log(`Server running on port ${PORT}. Bot: ${config.telegram_token ? 'online' : 'OFFLINE (no TELEGRAM_TOKEN)'}. YouTube: ${hasYoutubeAuth() ? 'authorized' : 'needs /api/auth/youtube'}.`);
});
