# Customer Portal - private report links

## Architecture

```text
Employee files -> Master RAW_DATA/NORMALIZED -> Supabase exact mirror -> Customer Portal
```

Customer files in Google Drive are no longer required for the new customer-facing report flow. Keep them as fallback during the transition.

## Create a private customer link

Use the client code from the `clients` table / Master customer list:

```bash
node scripts/generate-report-token.mjs CLIENT_CODE config/report-customers.local.json
```

The command writes only a SHA-256 token hash to the local config and prints the one-time private URL token. Do not commit, paste, or log the token. The local config is gitignored and should be mode 600.

Configure the server with:

```env
REPORT_PORTAL_CONFIG_FILE=/absolute/path/to/config/report-customers.local.json
```

Do not set both `REPORT_PORTAL_CONFIG_FILE` and `REPORT_PORTAL_CUSTOMERS_JSON`.

## Routes

- `/report/<token>` - customer report page
- `/api/report/<token>/status`
- `/api/report/<token>/overview`
- `/api/report/<token>/timeseries`
- `/api/report/<token>/posts`

Invalid tokens return 404. Queries are scoped by the customer code and active brand mapping in the database; browser-supplied customer IDs are not trusted.

## Local run

```bash
set -a; source .env.local; set +a
export REPORT_PORTAL_CONFIG_FILE="$PWD/config/report-customers.local.json"
node src/server.mjs
```

## Deployment later

For Cloud Run/VPS:

1. Store the customer config in Secret Manager or a protected mounted file.
2. Set `DATABASE_URL`, `DASHBOARD_AUTH_TOKEN`/Basic Auth, and `REPORT_PORTAL_CONFIG_FILE` as secrets.
3. Put the domain/reverse proxy in front of the service with HTTPS.
4. Keep `Cache-Control: no-store` and `noindex` for tokenized reports.
5. Rotate a customer link by generating a new token for that client code and replacing the config entry.

No Google Sheet write is involved in this portal.
