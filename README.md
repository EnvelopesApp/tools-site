# Toolshelf Website

Static GitHub Pages site for Envelopes App products.

## Live site

<https://envelopesapp.github.io/tools-site/>

The CleanCut card currently advertises:

- $19.99 launch price, paid once
- 3 free videos
- one-computer license
- Apple Silicon Mac
- macOS 14 Sonoma or later
- approximately 2 GB download
- private on-device video processing

Its download button uses the stable signed-release URL:

<https://github.com/EnvelopesApp/cleancut-updates/releases/latest/download/CleanCut.dmg>

Do not replace that link with a version-specific asset. Publishing a new
CleanCut GitHub release as latest updates the download automatically.

## Deployment

The site is plain `index.html` served by GitHub Pages from this repository.
After reviewing a change:

```bash
git add index.html README.md
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
