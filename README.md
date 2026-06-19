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
- `assets/cleancut-hero.jpg`: generated launch hero artwork
- `assets/lucide.min.js`: locally hosted interface icons

The CleanCut card currently advertises:

- $19.99 launch price, paid once
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

## Deployment

The site is plain `index.html` served by GitHub Pages from this repository.
After reviewing a change:

```bash
git add index.html apps.html about.html support.html privacy.html styles.css site.js \
  assets favicon.svg robots.txt sitemap.xml README.md
git commit -m "Describe the site change"
git push origin main
```

Then verify the live page after GitHub Pages deploys.

## Release boundary

Website edits and app releases are separate:

- Copy, price, platform requirements, or legal/contact changes require a
  website commit.
- A normal CleanCut app update requires only a new signed/notarized GitHub
  release; the stable download link follows it automatically.
- Never point the public button at an unsigned local build or a legacy update
  payload.
