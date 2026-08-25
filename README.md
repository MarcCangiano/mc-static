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
