# Toolshelf Analytics

Small Cloudflare Worker + D1 dashboard for Toolshelf launch analytics.

It tracks website events such as:

- `page_view`
- `ad_landing`
- `download_click`
- `checkout_click`
- `demo_play`
- `support_email_click`

CleanCut also sends privacy-preserving in-app funnel events:

- `app_first_launch`
- `app_launch`
- `video_completed`
- `trial_completed`
- `trial_limit_reached`
- `checkout_opened`
- `license_activated`

It does not store raw IP addresses or source media. It stores campaign
parameters, page paths, clicked target labels, anonymous session/install IDs,
country, broad device type, app version, platform/architecture, completed-video
counts, and selected tool combinations. It does not store video names, paths,
transcripts, subtitle text, detected words, license keys, buyer names, or buyer
emails.

## Deploy

```bash
cd /Users/ryansp/Developer/tools-site/analytics-worker
wrangler d1 create toolshelf_analytics
```

Copy the returned `database_id` into `wrangler.toml`, then:

```bash
wrangler d1 execute toolshelf_analytics --remote --file=schema.sql
printf 'your-dashboard-password\n' | wrangler secret put DASHBOARD_PASSWORD
wrangler deploy
```

Dashboard:

```text
https://toolshelf-analytics.<your-workers-subdomain>.workers.dev/admin
```

Use Basic Auth:

- Username: `ryan`
- Password: the `DASHBOARD_PASSWORD` secret

## Google Ads reporting

The dashboard can show Google Ads spend, impressions, clicks, CTR, and average
CPC beside website downloads, checkout clicks, and Polar purchases.

Website and Polar events are automatic. Google Ads can be automatic too: the
Worker has a scheduled Google Ads API importer that runs every 6 hours, plus a
private "Import Google Ads Now" button on the dashboard.

The Google Ads importer needs these Cloudflare Worker secrets before it can pull
real ad numbers:

```bash
wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
wrangler secret put GOOGLE_ADS_CLIENT_ID
wrangler secret put GOOGLE_ADS_CLIENT_SECRET
wrangler secret put GOOGLE_ADS_REFRESH_TOKEN
wrangler secret put GOOGLE_ADS_CUSTOMER_ID
```

Optional, if the ad account is under a manager account:

```bash
wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID
```

The OAuth refresh token must have the Google Ads scope:

```text
https://www.googleapis.com/auth/adwords
```

Once those secrets exist, either wait for the cron or click "Import Google Ads
Now":

```text
https://toolshelf-analytics.envelopes-app-com.workers.dev/admin
```

The fallback path is the dashboard form: copy daily numbers from Google Ads into
"Save Google Ads Snapshot" if API credentials are not set yet.

You can also save a snapshot with `curl`:

```bash
curl -u "ryan:$DASHBOARD_PASSWORD" \
  -H "content-type: application/json" \
  -d '{
    "snapshotDate": "2026-07-05",
    "platform": "google_ads",
    "campaignName": "Campaign #1",
    "app": "cleancut",
    "source": "google",
    "medium": "cpc",
    "campaign": "cleancut_search_test",
    "impressions": 0,
    "clicks": 0,
    "cost": 0,
    "costCurrency": "USD"
  }' \
  https://toolshelf-analytics.envelopes-app-com.workers.dev/api/ad-snapshots
```

If the automatic importer fails, the latest import status appears on the private
dashboard. The manual snapshot form remains available as a backup.
