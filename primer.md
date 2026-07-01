# Project Primer - VidIQ Telegram Bot

## Status
* Restored the complete codebase (Express server, Telegram bot) from the scratch folder to the project root.
* Installed all npm dependencies successfully.
* Configured local `client_secrets.json` for YouTube OAuth.
* Removed the old web dashboard (`public/`). The Express server is now only used for the YouTube OAuth callback.
* Removed `vidiq_wrapper.js` (the broken `npx mcp-remote` shim that mangled the bearer header on Windows). VidIQ MCP is now reached directly over HTTPS via `StreamableHTTPClientTransport` with the `VIDIQ_TOKEN` bearer — defined in `vidiq.js`.
* Discovered all **44 VidIQ MCP tools** by calling `client.listTools()` and saved them to `vidiq_tools.json` (committed; load at startup, use the schema for arg validation and `/donnie tool <name> help`).
* Fixed the trending flow. The real tool name is `vidiq_trending_videos` (not `vidiq_get_trending_videos`), requires `videoFormat` (long|short), and the response has no thumbnail — we fall back to `https://i.ytimg.com/vi/<id>/hqdefault.jpg` for the picker.
* Picker UX: 5 separate photo messages (thumbnail + caption + URL). Pick 2 by replying `.` to two of them; pipeline auto-starts.
* `/donnie` is the master command. Subcommands:
  - `(no args)` — trigger today's viral run
  - `prompt <text>` — set the default VidIQ clip-generation prompt
  - `video filter k=v` — set viral-search filters
  - `filters` — show current viral filters
  - `tools` — list all 44 VidIQ MCP tools
  - `tool <name> k=v ...` — call any VidIQ MCP tool directly
  - `tool <name> help` — show that tool's required/optional params
  - `balance` — check credits
  - `jobs` — list VidIQ jobs
  - Shortcuts: `trending [short|long]`, `outliers <keyword>`, `keyword <seed>`, `channel <@handle|UCid>`, `similar <niche>`, `transcript <videoId>`
* The YouTube upload pipeline (clip → schedule to YT Shorts, 3h apart) is unchanged.

## Next Steps
* Authorize the YouTube channel: open `http://localhost:8080/api/auth/youtube` in a browser, complete the OAuth flow, close the tab.
* In Telegram: `/start` to register the chat. Try `/donnie tools` to confirm the 44-tool registry is alive. Try `/donnie balance`. Then `/donnie` to test the full viral flow.
* Optionally commit `vidiq_tools.json` (already there) so others don't need to re-discover.

## Blockers
* None.
