# Project Primer - VidIQ Telegram Bot
* Deployed on Railway; auto-deploys from GitHub on push.
* Express app has trust proxy enabled and dynamically constructs redirect URI.
* Dynamic redirect URI prevents OAuth redirect mismatches caused by dynamic ports or deployment domains.

## Next Steps
1. Add `https://<railway-domain>/api/auth/youtube/callback` and `http://localhost:8080/api/auth/youtube/callback` to Google Console's Authorized Redirect URIs.
2. Visit `/api/auth/youtube` on the running instance to authorize.

## Blockers
* None (ensure correct test user email is added in Google Console under OAuth Consent Screen).
