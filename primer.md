# Project Primer - VidIQ Telegram Bot
* Deployed on Railway; auto-deploys from GitHub on push.
* Express app has trust proxy enabled and dynamically constructs redirect URI.
* Configured global undici dispatcher and transporter to disable keepAlive, bypassing Node.js native fetch "Premature close" errors.

## Next Steps
1. Add callback URIs (`https://<domain>/api/auth/youtube/callback`) to Google Console.
2. Visit `/api/auth/youtube` on the running instance to authorize.

## Blockers
* None (ensure correct test user email is added in Google Console under OAuth Consent Screen).
