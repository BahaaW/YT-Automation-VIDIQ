# Project Primer - VidIQ Telegram Bot
* Deployed on Railway; auto-deploys from GitHub on push.
* Express app has trust proxy enabled and dynamically constructs redirect URI.
* Disabled keepAlive on Google auth transporter to resolve the "Premature close" socket error.

## Next Steps
1. Add callback URIs (`https://<domain>/api/auth/youtube/callback`) to Google Console.
2. Visit `/api/auth/youtube` on the running instance to authorize.

## Blockers
* None (ensure correct test user email is added in Google Console under OAuth Consent Screen).
