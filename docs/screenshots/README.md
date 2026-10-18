# Screenshots

This directory holds screenshots of the **real** product: images captured from a running DSH with
this plugin installed, by a person looking at the panel.

It currently contains **no images**. No screenshot has been captured yet, so the repository ships
none, and nothing here pretends otherwise: there are no placeholder files, no invented file names and
no captions for images that do not exist. When a screenshot is actually captured, it is committed
here together with its caption (see the checklist below).

## Policy

- **Only real captures.** A screenshot must be a capture of a running DSH session with
  `dsh-trading-mode` installed and loaded, showing output the plugin actually produced — including
  its real loading, empty, degraded and error states when those are what is being illustrated.
- **No mock-ups as product screenshots.** AI-generated images, hand-drawn sketches, design
  comps, wireframes and edited/retouched renders must never be committed here as if they showed the
  product. If a mock-up is ever worth keeping, it is labelled as a mock-up in its own right and is not
  used to document behaviour, layout or data.
- **Caption every image** with the context a reader needs to judge it:
  - the market-data timestamp as shown in the panel (the panel's own `Updated` / `Last available
    data` line), and the freshness state it reported (`live`, `delayed`, `closed-session`, `stale`,
    `unknown`) — a screenshot of a stale quote must not read as a live one;
  - the environment: DSH version, operating system, and Node version if it is relevant;
  - the market and symbol or the surface shown;
  - the date the capture was taken, if it differs from the data timestamp.
- **Redact before committing.** Personal data must not leave the machine:
  - watchlist contents (add, remove or blur the symbols and names),
  - profile paths, user names, host names and local file paths,
  - tokens, API keys, session cookies or any credential, and the DSH launch token,
  - anything else identifying the operator or their machine.
  Redaction is part of the capture, not a follow-up task: redact, then look at the image once more
  before `git add`.
- **Keep file sizes sane.** Crop to the panel or the region being illustrated, prefer PNG, and avoid
  committing a wall of near-identical images — one good capture per state beats five variations.

## Capturing one

Before you start: run DSH, make sure the plugin is installed and loaded, and confirm the panel shows
what you intend to document.

- [ ] The panel is open on the state to be documented (and that state is a real result, not a
      reconstruction).
- [ ] The market-data timestamp is visible in the capture, and the freshness state is the one the
      plugin actually reported.
- [ ] The environment is recorded for the caption: DSH version, operating system, and Node version
      when relevant.
- [ ] Market and symbol (or the surface, if it is not symbol-specific) are recorded for the caption.
- [ ] Watchlist contents and any per-user list are removed, blurred or cropped away.
- [ ] Profile paths, user names, host names and local file paths are not visible anywhere in the frame.
- [ ] No token, API key, session cookie or launch token is visible, in the URL bar, the page or the
      developer tools.
- [ ] The image is cropped to the region being illustrated and is legible at its committed size.
- [ ] The file is committed under this directory with a descriptive name, and its caption above states
      the data timestamp, the freshness state, and the environment.

If a screenshot cannot satisfy these lines — for example the only capture available shows a real
watchlist you are not willing to publish — do not commit it. A missing screenshot is honest; a
redacted-to-unreadable or fabricated one is not.

## Where images live

All screenshots belong in `docs/screenshots/`. Documentation links to them with a relative path from
the referencing page, for example `screenshots/<file>.png` from another page under `docs/`, and a
caption that repeats the data timestamp and the environment so the image stays meaningful when it is
read out of context.
