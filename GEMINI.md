# VidIQ Telegram Bot - Project Guidelines

## Architecture
* **Backend**: Node.js Express server running in ES Module mode (`type: "module"`). The Express server is only used for the YouTube OAuth callback (`/api/auth/youtube` and `/api/auth/youtube/callback`).
* **VidIQ MCP client**: `vidiq.js` uses `StreamableHTTPClientTransport` directly against `https://mcp.vidiq.com/mcp` with the `VIDIQ_TOKEN` bearer — no wrapper, no `npx mcp-remote`, no stdio.
* **Tool registry**: `vidiq_tools.json` (committed) holds the list of 44 VidIQ MCP tools with their input/output schemas. Loaded at startup, used for arg validation and `/donnie tool <name> help`.
* **Telegram bot**: `telegraf` with `/start`, `/help`, `/status`, `/clip`, and the master `/donnie` command (see Commands).
* **YouTube upload**: `googleapis` (OAuth) to schedule generated clips to YouTube Shorts.

## Daily Flow
* At `daily_schedule_time` (default 09:00) the bot calls `vidiq_trending_videos` on the VidIQ MCP (filtered by `viral_filters`), sends the top 5 videos to Telegram as individual photo messages (thumbnail + caption + URL), then a summary "Pick 2 of 5" message.
* The user replies `.` to any 2 of the 5 video messages. Picks are matched by replied-to `message_id`. After 2 picks the pipeline auto-starts: each video generates 5 clips and schedules them to YouTube Shorts (3h apart) — 10 Shorts per day total.

## Commands
* `/start` — Register the chat.
* `/status` — State, last run, YouTube auth, default prompt, viral filters, tool count, history size.
* `/help` — Full command list.
* `/clip <url> | <prompt>` — Manual escape hatch.
* `/donnie` (no args) — Trigger today's viral run now.
* `/donnie prompt <text>` — Set the default VidIQ clip-generation prompt.
* `/donnie video filter k=v ...` — Set viral-search filters (passed to `vidiq_trending_videos`). `/donnie filters` shows them.
* `/donnie tools` — List all 44 VidIQ MCP tools.
* `/donnie tool <name> k=v ...` — Call any VidIQ MCP tool directly.
* `/donnie tool <name> help` — Show a tool's required/optional params.
* `/donnie balance` — Check credits.
* `/donnie jobs` — List VidIQ jobs.
* Shortcuts: `/donnie trending [short|long]`, `/donnie outliers <keyword>`, `/donnie keyword <seed>`, `/donnie channel <@handle|UCid>`, `/donnie similar <niche>`, `/donnie transcript <videoId>`.

## Picking Videos
* After `/donnie` (or the 09:00 cron) sends 5 photo messages, the user picks 2 by replying `.` to two of them. No buttons — reply-with-dot only.
* The summary message above is edited in place: `✓ 1/2 picked...` → `✓ 2/2 picked. Starting pipeline...`.

## Local Execution
* Start command: `npm start` or `npm run dev`.
* Local URL: `http://localhost:8080` (only the YouTube OAuth callback is served).

## Configurations
* Settings are saved to `config.json` in the project root (telegram token, chat ID, daily schedule, viral feed, picks, default prompt, viral filters).
* OAuth tokens are saved to `oauth_token.json`.
* `.env` holds the live secrets: `TELEGRAM_TOKEN`, `VIDIQ_TOKEN`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`. All gitignored.
* `vidiq_tools.json` is committed so others don't need to re-discover. To regenerate: run a one-off Node script that connects to the MCP via `StreamableHTTPClientTransport` and calls `client.listTools()`.

## Adding New Tool Shortcuts
The full VidIQ MCP tool surface is exposed via `/donnie tool <name> k=v ...`. To add a named shortcut, append a branch to `handleDonnieCommand()` in `server.js` and (optionally) a result formatter in `vidiq.js`. 44 tools are loaded; the user can iterate on coverage as needed.
