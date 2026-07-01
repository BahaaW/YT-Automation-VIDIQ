import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOOLS_JSON = path.join(__dirname, 'vidiq_tools.json');
const MCP_URL = 'https://mcp.vidiq.com/mcp';

let toolRegistry = new Map();

export function loadToolRegistry() {
  if (!fs.existsSync(TOOLS_JSON)) {
    throw new Error(`vidiq_tools.json not found at ${TOOLS_JSON}`);
  }
  const data = JSON.parse(fs.readFileSync(TOOLS_JSON, 'utf8'));
  toolRegistry = new Map();
  for (const tool of data.tools) {
    toolRegistry.set(tool.name, {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      outputSchema: tool.outputSchema || null
    });
  }
  return toolRegistry.size;
}

export function getRegisteredTools() {
  return toolRegistry;
}

export function getToolInfo(name) {
  return toolRegistry.get(name);
}

export function toolCount() {
  return toolRegistry.size;
}

export function summarizeTools() {
  return Array.from(toolRegistry.values()).map(t => `\`${t.name}\` — ${t.title}`).join('\n');
}

// === Low-level MCP call (creates a fresh client per call) ===

async function callMcp(name, args) {
  const token = process.env.VIDIQ_TOKEN;
  if (!token) throw new Error('VIDIQ_TOKEN not set in .env');

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  const client = new Client({ name: 'vidiq-telegram-bot', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: args || {} });
  } finally {
    try { await client.close(); } catch (_) {}
  }
}

function parseMcpResponse(response) {
  if (response == null) return null;
  if (typeof response === 'string') {
    try { return JSON.parse(response); } catch { return response; }
  }
  if (Array.isArray(response.content) && response.content[0] && response.content[0].text) {
    try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
  }
  return response;
}

// === Argument validation and coercion ===

function coerceValue(value, prop, key) {
  if (prop && prop.type === 'integer') {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`'${key}' must be an integer`);
    return n;
  }
  if (prop && prop.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`'${key}' must be a number`);
    return n;
  }
  if (prop && prop.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new Error(`'${key}' must be true or false`);
  }
  if (prop && prop.type === 'array') {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return value.split(',').map(s => s.trim()).filter(Boolean); }
    }
  }
  if (prop && prop.enum && !prop.enum.includes(value)) {
    throw new Error(`'${key}' must be one of: ${prop.enum.join(', ')}`);
  }
  return value;
}

function validateArgs(args, schema) {
  const properties = (schema && schema.properties) || {};
  const required = (schema && schema.required) || [];
  const coerced = {};
  for (const key of required) {
    if (args[key] === undefined || args[key] === '') {
      return { error: `missing required '${key}'`, required, properties };
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key];
    coerced[key] = coerceValue(value, prop, key);
  }
  return { coerced, required, properties };
}

// === Parse "key=value key2=value2 ..." arg list ===

export function parseKvArgs(tokens) {
  const out = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) throw new Error(`Bad arg "${token}". Use key=value (e.g. channelId=UCxxxx).`);
    out[token.substring(0, eq).trim()] = token.substring(eq + 1).trim();
  }
  return out;
}

// === Generic tool caller (used by /donnie tool) ===

export async function callTool(name, args) {
  const info = toolRegistry.get(name);
  if (!info) {
    const known = Array.from(toolRegistry.keys()).slice(0, 10).join(', ');
    throw new Error(`Unknown tool "${name}". Known: ${known}, ... (${toolRegistry.size} total). Try /donnie tools.`);
  }
  const v = validateArgs(args || {}, info.inputSchema);
  if (v.error) {
    const reqList = v.required.length ? `Required: ${v.required.join(', ')}.` : '';
    throw new Error(`${v.error}. ${reqList} Try /donnie tool ${name} help for full schema.`);
  }
  const raw = await callMcp(name, v.coerced);
  return { data: parseMcpResponse(raw), info };
}

// === Specific tool wrappers (used by the viral picker and explicit commands) ===

export async function getTrendingVideos(filters = {}) {
  const args = { videoFormat: 'long', limit: 5, ...filters };
  const r = await callTool('vidiq_trending_videos', args);
  const videos = (r.data && r.data.videos) || [];
  return videos.slice(0, 5).map((v, i) => ({
    index: i,
    videoId: v.videoId,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    title: v.videoTitle || `Video ${i + 1}`,
    channelTitle: v.channelTitle || 'Unknown channel',
    channelCountry: v.channelCountry || null,
    subscriberCount: v.subscriberCount,
    viewCount: v.viewCount,
    vph: v.vph,
    engagementRate: v.engagementRate,
    publishedAt: v.videoPublishedAt,
    duration: v.videoDuration,
    tags: v.videoTags || [],
    thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
  })).filter(v => v.videoId);
}

export async function getOutliers(filters = {}) {
  const r = await callTool('vidiq_outliers', filters);
  return r.data;
}

export async function getBalance() {
  const r = await callTool('vidiq_balance', {});
  return r.data;
}

export async function researchKeyword(keyword, options = {}) {
  return await callTool('vidiq_keyword_research', { keyword, ...options });
}

export async function searchYouTube(query, options = {}) {
  return await callTool('vidiq_youtube_search', { query, ...options });
}

export async function getChannelStats(channelId, from, to) {
  const args = { channelId };
  if (from) args.from = from;
  if (to) args.to = to;
  return await callTool('vidiq_channel_stats', args);
}

export async function getChannelSearch(query, filters = {}) {
  return await callTool('vidiq_channel_search', { query, ...filters });
}

export async function getVideoTranscript(videoId) {
  return await callTool('vidiq_video_transcript', { videoId });
}

export async function listJobs() {
  return await callTool('vidiq_jobs_list', {});
}

export async function generateClips(videoUrl, prompt, captionStyle = 'Loud & Clear') {
  return await callTool('vidiq_generate_clips', { videoUrl, prompt, captionStyle });
}

export async function pollJob(mcpJobId) {
  return await callTool('vidiq_job_poll', { mcpJobId });
}

// === Result formatters (compact, Telegram-friendly) ===

function shortNum(n) {
  if (n == null) return '?';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.substring(0, n - 1) + '…' : s;
}

export function formatTrendingVideos(data) {
  const videos = (data && data.videos) || [];
  if (!videos.length) return '_(no videos returned)_';
  return videos.slice(0, 10).map((v, i) =>
    `*${i + 1}.* ${truncate(v.videoTitle || '?', 60)}\n    ${v.channelTitle || '?'} • ${shortNum(v.viewCount)} views • ${shortNum(v.vph)} vph`
  ).join('\n\n');
}

export function formatOutliers(data) {
  const videos = (data && data.videos) || [];
  if (!videos.length) return '_(no outliers found)_';
  return videos.slice(0, 10).map((v, i) => {
    const score = v.breakoutScore != null ? ` • breakout ${v.breakoutScore.toFixed(1)}` : '';
    return `*${i + 1}.* ${truncate(v.videoTitle || '?', 60)}\n    ${v.channelTitle || '?'} • ${shortNum(v.viewCount)} views${score}`;
  }).join('\n\n');
}

export function formatBalance(data) {
  if (!data) return '_(no data)_';
  if (typeof data.balance === 'number') return `💰 Credits balance: *${data.balance}*`;
  if (typeof data.credits === 'number') return `💰 Credits: *${data.credits}*`;
  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

export function formatKeywordResearch(data) {
  if (!data) return '_(no data)_';
  const lines = [];
  if (data.seedKeyword && data.seedKeyword.keyword) {
    const s = data.seedKeyword;
    lines.push(`*${s.keyword}* — vol ${s.volume ?? '?'} • comp ${s.competition ?? '?'} • overall ${s.overall ?? '?'} • est ${shortNum(s.estimatedMonthlySearch)}/mo`);
    if (s.topMarkets && s.topMarkets.length) {
      lines.push(`    Top markets: ${s.topMarkets.slice(0, 5).map(m => `${m.country} ${(m.pct * 100).toFixed(0)}%`).join(', ')}`);
    }
  }
  if (data.relatedKeywords && data.relatedKeywords.length) {
    lines.push('');
    lines.push('*Related keywords:*');
    for (const k of data.relatedKeywords.slice(0, 15)) {
      lines.push(`  ${k.keyword} — vol ${k.volume ?? '?'} • comp ${k.competition ?? '?'} • overall ${k.overall ?? '?'}`);
    }
  }
  return lines.join('\n') || '_(empty)_';
}

export function formatChannelStats(data) {
  if (!data) return '_(no data)_';
  const s = data.currentStats || {};
  const g = data.growth || {};
  return [
    `*${data.title || data.channelId}*`,
    `Subs: ${shortNum(s.subscribers)} • Views: ${shortNum(s.views)} • Videos: ${shortNum(s.videos)}`,
    `Growth: +${shortNum(g.subscribersGained)} subs, +${shortNum(g.viewsGained)} views, +${shortNum(g.videosPublished)} videos`,
    data.country ? `Country: ${data.country}` : null,
    data.topics && data.topics.length ? `Topics: ${data.topics.slice(0, 5).join(', ')}` : null
  ].filter(Boolean).join('\n');
}

export function formatChannelSearch(data) {
  const channels = (data && data.channels) || [];
  if (!channels.length) return '_(no channels found)_';
  return channels.slice(0, 10).map((c, i) =>
    `*${i + 1}.* ${truncate(c.channelTitle || '?', 50)}\n    ${c.niche || '?'} • ${shortNum(c.subscriberCount)} subs • +${shortNum(c.subsGrowth30d)} (30d)`
  ).join('\n\n');
}

export function formatVideoTranscript(data) {
  if (!data) return '_(no data)_';
  if (typeof data === 'string') return truncate(data, 3500);
  if (data.transcript) return truncate(data.transcript, 3500);
  if (Array.isArray(data.segments)) {
    return data.segments.slice(0, 50).map(s => `[${s.start?.toFixed(0) || '?'}s] ${s.text || ''}`).join('\n').substring(0, 3500);
  }
  return '```json\n' + JSON.stringify(data, null, 2).substring(0, 3500) + '\n```';
}

export function formatGeneric(name, data) {
  if (data == null) return '_(no data)_';
  const str = JSON.stringify(data, null, 2);
  if (str.length <= 3500) return '```json\n' + str + '\n```';
  return '```json\n' + str.substring(0, 3500) + '\n…(truncated, ' + str.length + ' chars total)\n```';
}

export function formatToolResult(name, data) {
  switch (name) {
    case 'vidiq_trending_videos': return formatTrendingVideos(data);
    case 'vidiq_outliers': return formatOutliers(data);
    case 'vidiq_balance': return formatBalance(data);
    case 'vidiq_keyword_research': return formatKeywordResearch(data);
    case 'vidiq_channel_stats': return formatChannelStats(data);
    case 'vidiq_channel_search': return formatChannelSearch(data);
    case 'vidiq_video_transcript': return formatVideoTranscript(data);
    default: return formatGeneric(name, data);
  }
}

// === Schema help (for /donnie tool <name> help) ===

export function formatToolSchema(name) {
  const info = toolRegistry.get(name);
  if (!info) return `Unknown tool: ${name}`;
  const props = (info.inputSchema && info.inputSchema.properties) || {};
  const required = (info.inputSchema && info.inputSchema.required) || [];
  const lines = [`*${info.name}* — ${info.title}`, '', truncate(info.description || '', 600), '', '*Parameters:*'];
  for (const [key, prop] of Object.entries(props)) {
    const isReq = required.includes(key);
    const tag = isReq ? '_(required)_' : '_(optional)_';
    const type = prop.type || (prop.enum ? 'enum' : 'any');
    const opts = prop.enum ? ` {${prop.enum.join('|')}}` : '';
    lines.push(`  • \`${key}\` *${type}*${opts} ${tag}`);
    if (prop.description) lines.push(`      ${truncate(prop.description, 200)}`);
  }
  return lines.join('\n');
}
