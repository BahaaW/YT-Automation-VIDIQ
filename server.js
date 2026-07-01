import express from 'express';
import { Telegraf } from 'telegraf';
import { google } from 'googleapis';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import {
  loadToolRegistry,
  toolCount,
  getToolInfo,
  summarizeTools,
  callTool,
  parseKvArgs,
  getTrendingVideos,
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
  history: [],
  logs: [],
  viral_feed: [],
  viral_picks: [],
  viral_summary_message_id: null,
  vidiq_default_prompt: 'Highlight the most viral and engaging moments that work as standalone YouTube Shorts.',
  viral_filters: {}
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
    log('YouTube credentials missing. Set YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET or provide client_secrets.json. Uploads disabled.');
    return;
  }

  try {
    oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri || `http://localhost:${PORT}/api/auth/youtube/callback`);
    if (fs.existsSync(oauthTokenPath)) {
      oauth2Client.setCredentials(JSON.parse(fs.readFileSync(oauthTokenPath, 'utf8')));
      log('YouTube OAuth credentials loaded from file.');
    }
  } catch (e) {
    log('Failed to initialize YouTube auth: ' + e.message);
  }
}

initYoutubeAuth();

function hasYoutubeAuth() {
  return oauth2Client && oauth2Client.credentials && oauth2Client.credentials.access_token !== undefined;
}

app.get('/api/auth/youtube', (req, res) => {
  if (!oauth2Client) return res.status(500).json({ error: 'YouTube client not initialized.' });
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
    prompt: 'consent'
  });
  res.json({ url: authUrl });
});

app.get('/api/auth/youtube/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing authorization code.');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(oauthTokenPath, JSON.stringify(tokens, null, 2), 'utf8');
    log('YouTube authorization token saved.');
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
  log(`Submitting clipping job for URL: ${url}`);
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
  } catch (e) {
    log(`VidIQ submission failed: ${e.message}`);
    failRun(runEntry, `VidIQ submission failed: ${e.message}`);
  }
}

async function pollVidIQJob(runEntry) {
  let attempts = 0;
  const maxAttempts = 60;
  const interval = setInterval(async () => {
    attempts++;
    log(`Polling VidIQ job ${runEntry.mcpJobId} (attempt ${attempts}/${maxAttempts})…`);
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
    } catch (e) {
      log(`Polling error: ${e.message}`);
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
    const clips = runEntry.clips.slice(0, 5);
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const baseDate = new Date();
    baseDate.setMinutes(baseDate.getMinutes() + 10);

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      clip.status = 'downloading';
      saveConfig();
      const filePath = path.join(tempDir, `clip_${i}.mp4`);
      const writer = fs.createWriteStream(filePath);
      const res = await axios({ url: clip.downloadUrl, method: 'GET', responseType: 'stream' });
      res.data.pipe(writer);
      await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

      clip.status = 'uploading';
      saveConfig();
      const publishAt = new Date(baseDate.getTime() + i * 3 * 60 * 60 * 1000).toISOString();
      const up = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: {
            title: `${clip.title.substring(0, 70)} #Shorts`,
            description: `${clip.title}\n\nGenerated automatically via VidIQ.\n#Shorts #youtube #trending`,
            categoryId: '22'
          },
          status: { privacyStatus: 'private', publishAt, selfDeclaredMadeForKids: false }
        },
        media: { body: fs.createReadStream(filePath) }
      });
      clip.status = 'completed';
      clip.videoId = up.data.id;
      clip.scheduledAt = publishAt;
      saveConfig();
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    try { fs.rmdirSync(tempDir); } catch (_) {}

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
  if (t === config.daily_schedule_time && config.state === 'idle') {
    triggerDailyViralSearch();
  }
}, 60000);

async function triggerDailyViralSearch() {
  if (!bot || !config.telegram_chat_id) {
    log('Daily viral skipped: no bot/chat.');
    return;
  }
  config.state = 'fetching_viral';
  config.viral_feed = [];
  config.viral_picks = [];
  saveConfig();
  log('Daily viral search triggered.');
  try {
    const feed = await getTrendingVideos(config.viral_filters || {});
    if (!feed || feed.length < 2) {
      config.state = 'idle';
      saveConfig();
      await bot.telegram.sendMessage(config.telegram_chat_id, '⚠️ VidIQ returned too few trending videos. Skipping.');
      return;
    }
    config.viral_feed = feed;
    config.state = 'waiting_for_viral_pick';
    saveConfig();
    await sendViralPicker(feed);
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

async function sendViralPicker(feed) {
  for (const video of feed) {
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
  const summary = await bot.telegram.sendMessage(config.telegram_chat_id,
    '🎬 *Pick 2 of 5*\n\nReply `.` to any video above to pick it. After 2 picks, the pipeline starts automatically.',
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
    const next = config.viral_picks.length === 2
      ? `🎬 *Pick 2 of 5*\n\n✓ 2/2 picked. Starting pipeline…`
      : `🎬 *Pick 2 of 5*\n\n✓ 1/2 picked. Reply \`.\` to another video.`;
    bot.telegram.editMessageText(config.telegram_chat_id, config.viral_summary_message_id, null, next, { parse_mode: 'Markdown' }).catch(() => {});
  }
  if (config.viral_picks.length === 2) {
    runViralPicks().catch((e) => {
      log(`runViralPicks crashed: ${e.message}`);
      config.state = 'idle';
      saveConfig();
    });
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
      clips: []
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
        '/donnie jobs — List your VidIQ jobs.\n\n' +
        `Daily schedule: ${config.daily_schedule_time}.\n` +
        'After /donnie sends 5 video photos, reply `.` to 2 of them to pick. The pipeline auto-starts after 2 picks.',
        { parse_mode: 'Markdown' }
      );
    });

    bot.command('status', (ctx) => {
      const lines = [
        `*State:* \`${config.state}\``,
        `*Last run:* ${config.last_run || 'never'}`,
        `*YouTube auth:* ${hasYoutubeAuth() ? 'yes' : 'no'}`,
        `*Daily schedule:* ${config.daily_schedule_time}`,
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

    bot.on('text', (ctx) => {
      const text = ctx.message.text;
      const replyTo = ctx.message.reply_to_message;
      if (config.state === 'waiting_for_input') {
        handleTriggerInput(text, ctx);
      } else if (config.state === 'waiting_for_viral_pick') {
        if (text === '.' && replyTo) {
          handleViralReplyPick(ctx, replyTo.message_id);
        } else if (text === '.') {
          ctx.reply('Reply `.` to one of the 5 video messages above, not as a new message.');
        } else {
          ctx.reply('Pick 2 of the 5 viral videos by replying `.` to them. Type /help for the full command list.');
        }
      } else {
        ctx.reply(`Bot is currently \`${config.state}\`. Use /donnie or /clip. Type /help.`);
      }
    });

    bot.command('donnie', async (ctx) => {
      try { await handleDonnieCommand(ctx); }
      catch (e) {
        log(`Donnie command error: ${e.message}`);
        ctx.reply(`❌ ${e.message}`);
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

  return ctx.reply(
    'Unknown /donnie subcommand.\n\n' +
    'Try /donnie, /donnie prompt, /donnie video filter, /donnie filters, /donnie tools, /donnie tool `<name>`, /donnie balance, /donnie jobs, or one of the shortcuts (trending, outliers, keyword, channel, similar, transcript). Type /help for the full list.'
  );
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

initTelegramBot();

app.listen(PORT, () => {
  log(`Server running on port ${PORT}. Bot: ${config.telegram_token ? 'online' : 'OFFLINE (no TELEGRAM_TOKEN)'}. YouTube: ${hasYoutubeAuth() ? 'authorized' : 'needs /api/auth/youtube'}.`);
});
