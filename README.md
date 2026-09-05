# marccangiano.com

The site, as static files. No CMS, no database, no admin login.

## Why

It used to run on WordPress, which announced itself in the response headers
before the page had rendered:

```
link: <https://marccangiano.com/wp-json/>; rel="https://api.w.org/"
<meta name="generator" content="WordPress 7.1">
```

It is one page. It does not need a database.

## What the build does

`node build.js` reads the rendered page from the WordPress install, pulls every
asset it references, and writes `dist/`:

- rewrites `/wp-content/...` to `/assets/...`, flat, because the upload date
  folders stopped meaning anything
- drops the discovery endpoints WordPress advertises: `wp-json`, oEmbed, RSD,
  shortlink, the RSS feeds, the generator meta
- drops the emoji loader, which is 2KB of script polyfilling emoji for browsers
  that have not needed it in years
- renames the generated tokens: `--wp--preset--*` to `--mc--preset--*`,
  `wp-block-*` to `mc-block-*`. Pure renames, applied to the HTML and the
  stylesheet together. `wp-e2e-kit` and `wp-sentinel` are project names and are
  left alone
- **replaces the 113KB Breeze bundle with the theme's own 25 line script.** Most
  of that bundle was cache and prefetch machinery whose main activity was
  checking whether the current URL is `wp-admin`. On a static host it is dead
  weight
- de-duplicates the `description`, `og:description` and `twitter:description`
  tags, which WordPress was emitting twice each with different text
- writes `robots.txt` and `sitemap.xml`, which WordPress used to generate

## Verification

Not "it looked fine." The build was checked against the live WordPress render at
1280x3000 with headless Chrome:

- **0.28% of bytes differ against a 0.008% noise floor** (measured by rendering
  the live page twice and diffing it against itself). Every differing row was
  located and read: they are the spelling fixes below and the `wp-sentinel` ->
  `sentinel` rename reflowing their own lines. No layout moved
- **0 assets 404** during a full render
- **0 `wp-` tokens** left in the output
- the theme switcher was driven through the DevTools Protocol after the Breeze
  bundle was removed, because that was the one behaviour that could have broken:
  two buttons found, `data-theme` flips `null -> light -> dark`, `localStorage`
  persists it, body background moves between `rgb(8,8,10)` and
  `rgb(246,246,243)`, 0 JS errors

## Fixed on the way through

Six British spellings that had shipped live: `canonicalising`, `initialisation`,
`authorised`, and three `colour`. The static build is the source of truth now, so
they are fixed here.

## Loading state

While a photo streams in, its slot shows the site's own mark: the header's six
bars and dot, pulsing on a staggered 1.3s loop, centered on that photo's
dominant color (the image resized to one pixel at build time). The animation is
SMIL inside a shared 600-byte SVG, because SMIL is the one animation tech that
runs in SVG used as a CSS background — so the loading state, like everything
else here, ships no JavaScript. Native `loading="lazy"` handles when to fetch.

## Contact form

Posts to FormSubmit, the same destination as the Cangiano Industries and
Property Code forms, so everything lands in one inbox. No JavaScript, no
backend, no third party embed.

It is built from this site's own tokens rather than carried over as WPForms
markup: mono uppercase labels, the accent on the required marks and the button,
inputs that are a one pixel line until focus. Every color is a token, so the
theme switcher takes the form into light with it and there is no second set of
rules to keep in sync.

Two measurements set the column, because guessing at it was visibly wrong the
first time. `.mc-block-post-content>p` measures `68ch`, and `ch` resolves
against the element's own font size, so the form also carries the
`clamp(17px, 1.5vw, 20px)` the body copy sets inline. Without that second half
the form came out 685px against the prose column's 819 and sat noticeably
narrow.

`_honey` is a honeypot, positioned off canvas. Bots fill it, people never see
it, and FormSubmit drops anything that arrives with it set.

It carries `autocomplete="new-password"`, `aria-hidden` and the LastPass and
1Password ignore attributes, and every one of those is load bearing. With plain
`autocomplete="off"` Chrome autofilled the field for anyone who had a saved
address, FormSubmit binned the submission as a bot, and the visitor still got
the "Thanks!" page. It failed silently and only for real people: curl and a
headless browser both have no autofill profile, so every automated test passed
while the live form dropped everything. `off` is a hint Chrome ignores for name
and address fields; `new-password` is the value it honours.

The form is injected by `injectContact()` in `build.js` **and** stored in
`dist/`. Both, deliberately. `dist/` is the source of truth, but a rebuild
against the origin would otherwise scrape a page that has no form and quietly
overwrite it, and that particular loss looks like nothing at all until someone
tries to send a message. The function throws if its insertion point is missing
rather than writing a contactless page.

## Build

```
node build.js --resolve=45.55.204.32 --cname
```

`--resolve` pins every fetch to the Cloudways box the WordPress install still
lives on, with SNI and Host kept as the real domain — necessary since the DNS
cutover, because marccangiano.com now serves this build, and scraping it would
scrape its own output. `--cname` writes the custom-domain file for Pages.
ImageMagick is required (dominant colors). The WordPress install stays: it is
the editing surface, the build source, and the rollback.

No dependencies. `dist/` is committed so the deploy never depends on the scrape.

## Deploy

`.github/workflows/deploy.yml` publishes `dist/` to GitHub Pages on push to
`main`.

Asset paths are relative, not root relative, so the same build serves correctly
from a Pages project subpath and from the domain root.

The DNS cutover happened 2026-08-24: the apex A records point at GitHub's four
Pages addresses, `www` is a CNAME to `marccangiano.github.io`, and the MX and
TXT records were left untouched. `CNAME` is written by `--cname`.

Post-cutover fixes, each found by looking at the live site rather than assuming:

- Breeze had swapped every `img src` for a blank SVG placeholder with the real
  file in `data-breeze`, restored by the bundle's scroll handler — so dropping
  the bundle blanked every photo. The swap is resolved at build time now.
- The back to top button lives in the theme's second script, `assets/ui.js`,
  which Breeze had concatenated into the same bundle. Restored on its own tag.
- The `400` stroke animation's clock started when the CSS parsed, before first
  paint, so a cold load caught it mid-stroke. The choreography moved back 0.5s.
- Wappalyzer still called the site WordPress: the single-dash editor variables
  (`--wp-admin-theme-color` is literally one of its fingerprint patterns)
  survived the double-dash rename, and the orphan `img.wp-smiley` rule rode
  along in the minified CSS. Both gone; every Wappalyzer WordPress pattern now
  tests clean against production.
