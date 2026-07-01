# VidIQ Telegram Bot - Project Guidelines

## Architecture
* **Backend**: Node.js Express server running in ES Module mode (`type: "module"`). The Express server is only used for the YouTube OAuth callback (`/api/auth/youtube` and `/api/auth/youtube/callback`).
* **VidIQ MCP client**: `vidiq.js` uses `StreamableHTTPClientTransport` directly against `https://mcp.vidiq.com/mcp` with the `VIDIQ_TOKEN` bearer — no wrapper, no `npx mcp-remote`, no stdio.
* **Tool registry**: `vidiq_tools.json` (committed) holds the list of 44 VidIQ MCP tools with their input/output schemas. Loaded at startup, used for arg validation and `/donnie tool <name> help`.
* **Telegram bot**: `telegraf` with `/start`, `/help`, `/status`, `/clip`, and the master `/donnie` command (see Commands).
* **YouTube upload**: `googleapis` (OAuth) to schedule generated clips to YouTube Shorts.

## Daily Flow
* At `daily_schedule_time` (default 09:00) the bot calls `vidiq_trending_videos` on the VidIQ MCP (filtered by `viral_filters`), sends the top 5 videos to Telegram as individual photo messages (thumbnail + caption + URL), then a summary "Pick 2 of 5" message. Extra passes in `schedule_passes` array also trigger runs at their times.
* The user replies `.` to any 2 of the 5 video messages. Picks are matched by replied-to `message_id`. After 2 picks the bot shows a preview with the two selected videos and asks for approval (`y`/`n`). On `y` the pipeline auto-starts: each video generates clips (max `clip_count`) and schedules them to YouTube Shorts (3h apart).
* Pipeline retries: `generateClips`, `pollJob`, per-clip download, and per-clip upload each retry up to 3 times with exponential backoff (`1000 * attempt` ms).
* Stop mechanism: set `stop_requested: true` in config. Checked before each major pipeline stage. On next check the pipeline aborts abruptly via `failRun()`.

## Commands
* `/start` — Register the chat.
* `/status` — State, last run, YouTube auth, niche override, clip count, schedule passes, default prompt, viral filters, tool count, history size.
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
* `/donnie schedule HH:MM` — Set the daily schedule time.
* `/donnie niche <text>` — Override trending search niche. Omit text to clear.
* `/donnie stop` — Request abort of the current run at next check point.
* `/donnie clipcount <1-20>` — Set max clips per video.
* `/donnie passes HH:MM [HH:MM ...]` — Set extra schedule passes for additional daily runs.
* `/donnie stats` — Show performance stats: total runs, clips, niches used.
* Shortcuts: `/donnie trending [short|long]`, `/donnie outliers <keyword>`, `/donnie keyword <seed>`, `/donnie channel <@handle|UCid>`, `/donnie similar <niche>`, `/donnie transcript <videoId>`.

## Picking Videos
* After `/donnie` (or the 09:00 cron) sends 5 photo messages, the user picks 2 by replying `.` to two of them. No buttons — reply-with-dot only.
* After 2 picks, a preview message shows the titles and asks for `y`/`n` approval before starting the pipeline. `y` runs it, `n` clears picks. The summary message is edited in place: `✓ 1/2 picked...` → `✓ 2/2 picked. Starting pipeline...`.

## Retry & Error Handling
* All network-sensitive operations (clip generation, job polling, clip download, upload) use a 3-attempt for-loop with `sleep(1000 * attempt)` ms backoff.
* `stop_requested` flag is checked at coarse boundaries (start of each major pipeline stage) to keep response fast.
* Video stats (`video_stats[]`) records each run's result: `{videoId, clipCount, scheduledAt, niche, sourceUrl, clips: [...]}`.
* `pending_preview` stores picks while waiting for user approval; cleared on `y` or `n`.

## Local Execution
* Start command: `npm start` or `npm run dev`.
* Local URL: `http://localhost:8080` (only the YouTube OAuth callback is served).

## Configurations
* Settings are saved to `config.json` in the project root (telegram token, chat ID, daily schedule, viral feed, picks, default prompt, viral filters).
* New config fields: `niche_override`, `stop_requested`, `schedule_passes[]`, `clip_count` (default 5), `video_stats[]`, `pending_preview`.
* OAuth tokens are saved to `oauth_token.json`.
* `.env` holds the live secrets: `TELEGRAM_TOKEN`, `VIDIQ_TOKEN`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`. All gitignored.
* `vidiq_tools.json` is committed so others don't need to re-discover. To regenerate: run a one-off Node script that connects to the MCP via `StreamableHTTPClientTransport` and calls `client.listTools()`.

## Adding New Tool Shortcuts
The full VidIQ MCP tool surface is exposed via `/donnie tool <name> k=v ...`. To add a named shortcut, append a branch to `handleDonnieCommand()` in `server.js` and (optionally) a result formatter in `vidiq.js`. 44 tools are loaded; the user can iterate on coverage as needed.
