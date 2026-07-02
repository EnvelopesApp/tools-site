# Toolshelf Analytics

Small Cloudflare Worker + D1 dashboard for Toolshelf launch analytics.

It tracks website events such as:

- `page_view`
- `ad_landing`
- `download_click`
- `checkout_click`
- `demo_play`
- `support_email_click`

It does not store raw IP addresses or source media. It stores campaign
parameters, page paths, clicked target labels, anonymous session IDs, country,
and broad device type.

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
