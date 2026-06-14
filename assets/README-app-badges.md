# App Store badges — provenance & refresh instructions

`app-store-badge.svg` and `google-play-badge.png` are the **official,
unmodified badge artwork** downloaded from Apple's and Google's badge
generators (URLs below). They are committed to the repo (2026-06-12)
because packaged releases are built by CI from a tag — un-committed
assets would silently drop out of every shipped build. Using the
badges to link to ECHOCAT's own store listing is exactly the use the
Apple and Google marketing guidelines license; do not edit the files,
recolor them, or use them for anything else.

If a file is removed, the `<img>` tags in `renderer/index.html`
gracefully degrade to alt text ("Download on the App Store" / "Get it
on Google Play").

## Apple — App Store badge

**Drop file at:** `assets/app-store-badge.svg`

Use Apple's per-app badge generator (preferred — it's signed to your
app id and color-matched to the current marketing guidelines):

  https://tools.applemediaservices.com/app/6766321194?country=us

Pick "Black" / "English" / SVG and download. Expected dimensions:
roughly 150 × 50px when rendered at the CSS height (50px). Apple's
guidelines require **no modification** to the artwork; the surrounding
clear-space and minimum-size rules are documented at:

  https://developer.apple.com/app-store/marketing/guidelines/

## Google Play — "Get it on Google Play" badge

**Drop file at:** `assets/google-play-badge.png`

Direct URL (stable, generic English PNG):

  https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png

Or the official badge generator:

  https://play.google.com/intl/en_us/badges/

Expected aspect ratio: ~3.36 : 1 (e.g. 168 × 50px at our render
size). The badge is currently displayed with reduced opacity and a
"Coming Soon" overlay because the Android build hasn't shipped. When
it does, in `renderer/index.html`:

  - swap the wrapping `<span class="settings-echocat-badge-link ...">`
    to `<a href="https://play.google.com/store/apps/details?id=…"
    data-external="1">`,
  - drop the `settings-echocat-badge-disabled` class,
  - remove the `.settings-echocat-badge-overlay` child span.

## Brand-guideline notes

- **Apple:** never recolor, rotate, distort, or embellish the badge.
  Keep at least 1/10 of the badge height as clear space around it.
- **Google:** the badge must not be modified or used as a background.
  Minimum height 60dp at default density (we render at 50px in the
  desktop renderer, which is acceptable given the dialog context but
  worth a sanity-check by you before App Store distribution).

The CSS in `renderer/styles.css` (`.settings-echocat-badge-*`) does
not modify the artwork — it scales by height only and the "Coming
Soon" overlay sits in a separate layered text box above the badge,
not painted onto it.
