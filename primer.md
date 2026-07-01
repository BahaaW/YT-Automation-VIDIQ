# Project Primer - VidIQ Telegram Bot

## Status
* Deployed on Railway; auto-deploys from GitHub on push.
* All 44 VidIQ MCP tools loaded via `vidiq_tools.json`.
* Viral picker fully built: batches of 5 ranked shorts, refresh pagination, pick-2 pipeline with preview/approval.
* `vidiq.js`: `getTrendingVideos()` defaults to shorts (limit 10, 1M+ views, 7 days). `rankVideos()` added with min-max normalization (vph×0.4 + engagementRate×0.4 + viewCount×0.2).
* `server.js`: all viral picker changes done — `sendViralPicker()` accepts `startIndex`, `refreshViralFeed()` paginates offset, picks survive across batches, summary shows batch range.
* Health check at `<railway-url>/health` — expect `{"telegram":true,"vidiq_tools":44}`.

## Next Steps
1. Test viral feed refresh: `/donnie run` then `/donnie refresh` — verify batch 2 shows without clearing picks.
2. Verify `rankVideos` scoring in logs.
3. YouTube OAuth: update redirect URIs and authorize.

## Blockers
* YouTube OAuth not yet authorized for Railway deployment.
