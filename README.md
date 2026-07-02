# Toolshelf Website

Static GitHub Pages site for Envelopes App products.

## Live site

<https://envelopesapp.github.io/tools-site/>

## Pages

- `index.html`: CleanCut product, pricing, download, and purchase page
- `apps.html`: expandable catalog for CleanCut and future products
- `about.html`: Toolshelf/Envelopes product principles and contact
- `support.html`: installation, license, update, and processing help
- `privacy.html`: local-processing and network-connection disclosure
- `styles.css`: shared responsive design
- `site.js`: mobile navigation and local Lucide icon setup
- `apps.json`: app catalog and launch metadata for agents/future automation
- `docs/APP_LAUNCH_PLAYBOOK.md`: shared launch/license/release playbook
- `docs/APP_AGENT_TEMPLATE.md`: starter `AGENTS.md` / `CLAUDE.md` for new apps
- `docs/APP_PRODUCT_RECORD_TEMPLATE.md`: starter product record for new apps
- `assets/cleancut-hero.jpg`: generated launch hero artwork
- `assets/cleancut-demo-1920x1080.mp4`: CleanCut demo video used on the home page
- `assets/cleancut-demo-1920x1080-captions.vtt`: captions for the CleanCut demo video
- `assets/lucide.min.js`: locally hosted interface icons
- `analytics-worker/`: private Cloudflare Worker + D1 dashboard for launch
  analytics

The CleanCut card currently advertises:

- $19.99 launch price, paid once
- public beta / early access positioning
- limited-time lifetime launch deal
- 3 free videos
- one-computer license
- Apple Silicon and Intel Mac
- macOS 14 Sonoma or later
- approximately 2 GB download
- private on-device video processing

Its Mac download buttons use the stable signed-release URLs:

<https://github.com/EnvelopesApp/cleancut-updates/releases/latest/download/CleanCut.dmg>

<https://github.com/EnvelopesApp/cleancut-updates/releases/latest/download/CleanCut-Intel.dmg>

Do not replace those links with version-specific assets. Publishing a new
CleanCut GitHub release as latest updates the downloads automatically.

## Adding Another App

Start in `/Users/ryansp/Developer/APP_LAUNCH_PLAYBOOK.md`, which points to the
version-controlled playbook in `docs/`. Every new app should have its own app
folder instructions, Polar product/license benefit, release repo or release
plan, and product record before the website advertises it as available.

Website sequence:

1. Add the app to `apps.json`.
2. Add or update the card in `apps.html`.
3. Add a full showcase page when the app is ready for public attention.
4. Add support/privacy copy for anything app-specific.
5. Use stable release URLs for downloads.
6. Keep unavailable platforms clearly disabled or marked coming soon.
7. Update `sitemap.xml` when a new public HTML page is added.
8. Commit, push, wait for GitHub Pages, and verify the live page.

The current CleanCut page can remain the home page until the site is ready for
a broader Toolshelf landing page. PolishKey is live through `polishkey.html`
and the app catalog.

## Deployment

The site is plain `index.html` served by GitHub Pages from this repository.
After reviewing a change:

```bash
git add index.html apps.html about.html support.html privacy.html styles.css site.js \
  apps.json docs assets favicon.svg robots.txt sitemap.xml README.md AGENTS.md CLAUDE.md
git commit -m "Describe the site change"
git push origin main
```

Then verify the live page after GitHub Pages deploys.

## Analytics dashboard

The private launch dashboard is deployed as a Cloudflare Worker:

<https://toolshelf-analytics.envelopes-app-com.workers.dev/admin>

It stores simple website events in D1: page views, paid landings, demo plays,
download clicks, checkout clicks, support email clicks, campaign parameters,
referrer host, broad device type, language, and country. It also accepts signed
Polar webhooks at `/polar/webhook` for paid/refunded orders so the dashboard can
show purchases and revenue. It does not store raw IP addresses, source videos,
selected text, transcripts, license keys, Polar buyer names/emails, or card
details.

The dashboard uses Basic Auth. The username is `ryan`; the password is stored
as the Worker secret `DASHBOARD_PASSWORD`.

The Polar webhook secret is stored as the Worker secret
`POLAR_WEBHOOK_SECRET`.

## Release boundary

Website edits and app releases are separate:

- Copy, price, platform requirements, or legal/contact changes require a
  website commit.
- A normal CleanCut app update requires only a new signed/notarized GitHub
  release; the stable download link follows it automatically.
- Never point the public button at an unsigned local build or a legacy update
  payload.
