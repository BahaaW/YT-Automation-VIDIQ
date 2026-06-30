# VidIQ Telegram Bot Dashboard - Project Guidelines

## Architecture
* **Backend**: Node.js Express server running in ES Module mode (`type: "module"`).
* **Frontend**: Vanilla HTML/CSS/JS located in the `public/` directory.
* **Integrations**: Telegraf (Telegram), YouTube Data API (Googleapis), and `@modelcontextprotocol/sdk` (VidIQ).

## Local Execution
* Start command: `npm start` or `npm run dev`.
* Local URL: `http://localhost:8080`.

## Configurations
* Settings are saved to `config.json` in the project root.
* OAuth tokens are saved to `oauth_token.json`.
