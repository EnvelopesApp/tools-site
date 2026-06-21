# Envelopes App Launch Playbook

This is the shared source of truth for launching and maintaining Envelopes /
Toolshelf apps. Use it for every app that needs a website page, license,
checkout, download, update flow, or public release.

## How To Use This

For every app launch thread, make sure the agent can read:

- the app project folder
- `/Users/ryansp/Developer/tools-site`
- the root pointer: `/Users/ryansp/Developer/APP_LAUNCH_PLAYBOOK.md`
- the canonical playbook:
  `/Users/ryansp/Developer/tools-site/docs/APP_LAUNCH_PLAYBOOK.md`
- any existing shipped app used as a reference, such as CleanCut

If an app lives outside `/Users/ryansp/Developer`, either add that folder as a
workspace root for the chat or move/copy the app into `/Users/ryansp/Developer`
before asking the agent to wire website, release, and license work together.

At the start of a new app thread, tell the agent:

```text
Read /Users/ryansp/Developer/AGENTS.md and
/Users/ryansp/Developer/APP_LAUNCH_PLAYBOOK.md first. This app should ship
through the same Toolshelf website, Polar licensing, and GitHub release pattern
as CleanCut, but with its own product IDs and release assets.
```

## Product Boundaries

Each app must have its own:

- app name and slug
- bundle ID / package ID
- storage keys for settings, trials, and license data
- Polar product
- Polar license key benefit
- checkout link
- release repository or release plan
- public download asset names
- support notes
- release checklist
- local `AGENTS.md` and `CLAUDE.md`

Never reuse CleanCut's bundle ID, Polar product, license benefit, checkout URL,
GitHub release assets, updater URLs, or app-storage keys for another product.

## Recommended Per-App Files

Each app folder should contain these before launch:

- `AGENTS.md`: Codex instructions for that app
- `CLAUDE.md`: Claude Code instructions for that app
- `README.md`: current app state and development commands
- `RELEASE.md`: exact publish procedure
- `NEXT_STEPS.md`: current production status and owner checklist
- `BACKUP.md`: source, signing, and recovery notes
- platform-specific handoff docs if needed, such as `WINDOWS_HANDOFF.md`

Use `/Users/ryansp/Developer/APP_AGENT_TEMPLATE.md` to create the first two.
Use `/Users/ryansp/Developer/APP_PRODUCT_RECORD_TEMPLATE.md` to collect the
business and release details before wiring the website.

## Polar License Pattern

Use Polar for direct sales unless the owner explicitly decides otherwise.

For each app:

1. Create a new Polar product.
2. Use a one-time price unless the product clearly needs recurring service.
3. Create a new license key benefit for that product.
4. Configure the activation limit, usually one computer.
5. Copy the new product, checkout, and license-benefit IDs into only that app.
6. Verify activation, deactivation, offline behavior, and a moved-computer flow.
7. Confirm the live checkout shows the intended price and one-time language.

Keep CleanCut as the reference implementation, not as a source of IDs.

## GitHub Release Pattern

Prefer one release repository per paid app. That keeps update feeds and assets
simple and avoids one app accidentally downloading another app.

Suggested repo naming:

```text
EnvelopesApp/<app-slug>-updates
```

Each public release should:

- use a new semantic version and tag
- publish complete signed/notarized installers or DMGs
- include release notes explaining user-facing changes
- keep stable download URLs for the website and in-app updater
- avoid mutating old release tags
- have a rollback path by marking the last known-good release as latest

Never point the website at an unsigned local build, a development artifact, or a
legacy in-place update payload.

## Website Pattern

The website lives in:

```text
/Users/ryansp/Developer/tools-site
```

Current public site:

```text
https://envelopesapp.github.io/tools-site/
```

The site should evolve toward this shape:

- `index.html`: Toolshelf home once multiple apps are ready
- `apps.html`: catalog of all apps
- one full showcase page per app, for example `cleancut.html`
- `support.html`: shared support with app-specific sections
- `privacy.html`: shared privacy, updated for each app's data behavior
- `apps.json`: source-of-truth catalog used by humans and future automation

When adding an app to the site:

1. Add the app to `tools-site/apps.json`.
2. Add or update the app card in `apps.html`.
3. Add a full showcase page if the app is public or near-public.
4. Add support, privacy, requirements, and pricing copy.
5. Add stable download URLs, not local paths.
6. Update `sitemap.xml` if a new public HTML page is added.
7. Commit and push `tools-site`.
8. Verify the GitHub Pages deploy and live pages.

## App Launch Checklist

Before public launch:

- The app has a clear name, slug, icon, and support email.
- Pricing is decided and shown consistently on Polar and the website.
- Trial limits and license rules are implemented and tested.
- The app has its own app-storage keys and bundle/package ID.
- The checkout completes a real or test purchase.
- License activation, deactivation, and reactivation are tested.
- Update checks use the correct release repo and asset names.
- Installers are signed/notarized where applicable.
- A clean-machine smoke test passes.
- The website has the correct download, price, platform, and support copy.
- `README.md`, `RELEASE.md`, and `NEXT_STEPS.md` are current.
- Recovery notes exist for a bad release.

## Maintenance Rhythm

Use this lightweight routine to keep everything organized:

- After every app release, update that app's `NEXT_STEPS.md`.
- After every website change, update `tools-site/README.md` or `apps.json` if
  the app catalog changed.
- After every Polar change, update the app's product record.
- Once a week during active launch work, review all `NEXT_STEPS.md` files and
  choose the next highest-risk item.
- Before asking another chat to work on an app, paste the startup instruction
  from "How To Use This" and make sure the app has a local `AGENTS.md`.

## Keep / Change Defaults

Keep:

- one shared Toolshelf website
- one support identity unless a product needs its own
- one-time pricing for small utility apps unless there is ongoing server cost
- per-app release repos
- per-app Polar products/license benefits
- complete installer updates instead of self-modifying signed apps

Change only when the product requires it:

- subscription pricing
- shared license across multiple apps
- shared release repository
- separate product website
- organization-specific support inboxes

## CleanCut Reference

CleanCut is the first live paid app and the best reference for:

- direct macOS distribution
- Polar one-time license keys
- one-computer activation
- trial gating
- GitHub Releases update checks
- Toolshelf website copy and support structure

Before touching CleanCut itself, read:

- `/Users/ryansp/Developer/video_censor_desktop/AGENTS.md`
- `/Users/ryansp/Developer/video_censor_desktop/RELEASE.md`
- `/Users/ryansp/Developer/video_censor_desktop/NEXT_STEPS.md`
- `/Users/ryansp/Developer/video_censor_mac/README.md`
- `/Users/ryansp/Developer/video_censor_mac/AUDIO_POLICY.md`
