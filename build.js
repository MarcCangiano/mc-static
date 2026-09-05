#!/usr/bin/env node
/**
 * Build a static marccangiano.com out of the live WordPress render.
 *
 * The local block theme goes stale the moment anything is edited in the admin,
 * so the live HTML is the source of truth here, not ~/Documents/mc-theme.
 * This fetches the rendered page, pulls every asset it references, rewrites the
 * paths, and strips the things that only exist because WordPress served it.
 *
 * Deliberately dependency free: node build.js, nothing to install.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

// After the DNS cutover this domain serves the static build, so pointing the
// scraper at it would just re-scrape its own output. Pass --origin=<url> to
// build from wherever the WordPress install still lives.
const argOrigin = process.argv.find((a) => a.startsWith("--origin="));
const ORIGIN = argOrigin ? argOrigin.split("=")[1].replace(/\/$/, "") : "https://marccangiano.com";
const CANONICAL = "https://marccangiano.com";

// After the cutover the domain resolves to GitHub Pages, so fetching ORIGIN
// would scrape this build's own output. --resolve=<ip> pins every fetch to the
// Cloudways box the WordPress install still lives on, with SNI and Host kept
// as the real domain so the cert and vhost both match. curl --resolve, at home.
const argResolve = process.argv.find((a) => a.startsWith("--resolve="));
const PIN = argResolve ? argResolve.split("=")[1] : null;
if (PIN) {
  const https = require("node:https");
  const { URL } = require("node:url");
  globalThis.fetch = (input) =>
    new Promise((resolve, reject) => {
      const u = new URL(String(input));
      const req = https.request(
        { host: PIN, servername: u.hostname, path: u.pathname + u.search,
          headers: { Host: u.hostname, "User-Agent": "mc-static-build" } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              text: async () => buf.toString("utf8"),
              arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
}
const OUT = path.join(__dirname, "dist");
const ASSETS = path.join(OUT, "assets");

// Cache-busting query strings make filenames ugly and change on every Breeze
// purge. The build is the cache buster now.
const stripVer = (u) => u.split("?")[0].split("#")[0];

// wp-content/uploads/2026/08/foo.png -> assets/img/foo.png. Flat, because the
// upload date folders carry no meaning once WordPress is gone.
function localPath(url) {
  const clean = stripVer(url);
  const base = path.basename(clean);
  if (clean.includes("/cache/breeze-minification/css/")) return "assets/site.css";
  if (clean.includes("/cache/breeze-minification/js/")) return "assets/site.js";
  return "assets/img/" + base;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return buf;
}

function collectAssetUrls(text) {
  const out = new Set();
  const re = new RegExp(
    ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "\\/wp-(?:content|includes)\\/[^\"'\\s)\\\\]+",
    "g"
  );
  for (const m of text.matchAll(re)) {
    const u = m[0].replace(/&#0?38;/g, "&");
    if (u.includes("/wp-includes/js/wp-emoji")) continue; // dropped entirely
    out.add(u);
  }
  return [...out];
}

function stripWordPress(html) {
  const kill = [
    // Discovery endpoints. The wp-json Link header is the loudest tell of all
    // and it is gone with the server, but these live in the markup.
    /<link rel="https:\/\/api\.w\.org\/"[^>]*>\s*/g,
    /<link rel="alternate"[^>]*(?:oembed|wp\/v2\/pages)[^>]*>\s*/g,
    /<link rel="EditURI"[^>]*>\s*/g,
    /<link rel=['"]shortlink['"][^>]*>\s*/g,
    /<link rel="alternate" type="application\/rss\+xml"[^>]*>\s*/g,
    /<meta name="generator"[^>]*>\s*/g,
    /<link rel=['"]pingback['"][^>]*>\s*/g,
    // The emoji loader is ~2KB of script to polyfill emoji in browsers that
    // have not needed it in years.
    /<script[^>]*>[\s\S]*?wp-emoji-loader[\s\S]*?<\/script>\s*/g,
    /<style[^>]*>\s*img\.wp-smiley[\s\S]*?<\/style>\s*/g,
  ];
  for (const re of kill) html = html.replace(re, "");
  return html;
}

// WordPress emits duplicate description/og:description/twitter:description
// pairs on this page, one from the theme and one from elsewhere. Two of each
// is worse than one; keep the first, drop later duplicates by name/property.
function dedupeMeta(html) {
  const seen = new Set();
  return html.replace(/<meta\s+(name|property)=["']([^"']+)["'][^>]*>\s*/g, (tag, _a, key) => {
    if (!/^(description|og:description|twitter:description|og:title|twitter:title)$/.test(key)) return tag;
    if (seen.has(key)) return "";
    seen.add(key);
    return tag;
  });
}


// WordPress block classes are the other half of the tell. This is a token
// rename over an explicit allowlist of prefixes WordPress generates, applied
// to the HTML and the stylesheet together so the selectors keep matching.
// wp-sentinel and wp-e2e-kit are Marc's own project names and must survive.
const CLASS_RENAMES = [
  // Single-dash editor variables (--wp-admin-theme-color and friends). The
  // double-dash --wp--preset family is renamed earlier; this catches the rest,
  // and --wp-admin-theme-color is literally one of Wappalyzer's WordPress
  // fingerprints.
  ["--wp-", "--mc-"],
  ["wp-block-", "mc-block-"],
  ["wp-site-blocks", "mc-site-blocks"],
  ["wp-container-", "mc-container-"],
  ["wp-element-", "mc-element-"],
  ["wp-img-", "mc-img-"],
  ["wp-theme-", "mc-theme-"],
  ["wp--skip-link--target", "mc--skip-link--target"],
  ["wp-skip-link", "mc-skip-link"],
  ["wp-image-", "mc-image-"],
  ["wp-singular", "mc-singular"],
  ["wp-embed-responsive", "mc-embed-responsive"],
];
// The emoji loader was stripped from the HTML, but Breeze's minified CSS
// still carried its orphan rule. No element has either class anymore.
function dropEmojiRule(text) {
  return text.replace(/img\.wp-smiley,img\.emoji\{[^}]*\}/g, "");
}

function renameClasses(text) {
  for (const [from, to] of CLASS_RENAMES) text = text.split(from).join(to);
  return text;
}

// Standing rule: American spelling everywhere. These six shipped on the live
// site; the static build is the source of truth now, so they get fixed here
// rather than in an admin screen that will go away.
const SPELLING = [
  [/canonicalising/g, "canonicalizing"],
  [/initialisation/g, "initialization"],
  [/authorised/g, "authorized"],
  [/\bcolour\b/g, "color"],
];
// The project is called sentinel on the site. The href still points at the
// repo's real name, so only the link text changes here — renaming the repo is
// a separate decision.
function renameProjects(text) {
  return text.replace(/>wp-sentinel</g, ">sentinel<");
}

// The 400 draws in with a stroke animation whose clock starts when the CSS
// parses, which is before first paint finishes, so on a cold load it appeared
// mid-stroke. Push the whole choreography back half a second: draw, unstroke,
// fill (CSS delays) and the shine gradient (an SMIL begin inside the SVG).
function delayNumberDraw(css) {
  return css
    .replace("mc-num-draw 1.9s cubic-bezier(.35,0,.25,1) .4s",
             "mc-num-draw 1.9s cubic-bezier(.35,0,.25,1) .9s")
    .replace("mc-num-unstroke .8s ease 2.2s", "mc-num-unstroke .8s ease 2.7s")
    .replace("mc-num-fill .8s cubic-bezier(.4,0,.2,1) 2.2s",
             "mc-num-fill .8s cubic-bezier(.4,0,.2,1) 2.7s");
}
function delayNumberShine(html) {
  return html.replace('begin="3.15s"', 'begin="3.65s"');
}

function americanize(text) {
  for (const [re, to] of SPELLING) text = text.replace(re, to);
  return text;
}

// Breeze concatenated Marc's 25 line theme switcher into 113KB of its own
// cache and prefetch machinery, most of which checks whether the current URL
// is wp-admin. None of that means anything on a static host, so the bundle is
// dropped and the theme's own script is inlined from the theme source.
// Breeze replaces every img src with a blank SVG data URI and parks the real
// file in data-breeze, then swaps them back in JavaScript on scroll. Dropping
// its bundle therefore left every photo as a transparent placeholder. Resolve
// the swap here instead, at build time, so the images need no JavaScript at
// all. loading="lazy" stays: the browser does that natively.
function unlazy(html) {
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    const real = /data-breeze="([^"]*)"/.exec(tag);
    if (!real) return tag;
    const srcset = /data-brsrcset="([^"]*)"/.exec(tag);
    const sizes = /data-brsizes="([^"]*)"/.exec(tag);
    let out = tag
      .replace(/\ssrc="[^"]*"/, ` src="${real[1]}"`)
      .replace(/\sdata-breeze="[^"]*"/, "")
      .replace(/\sdata-brsrcset="[^"]*"/, "")
      .replace(/\sdata-brsizes="[^"]*"/, "")
      .replace(/\s?\bbr-lazy\b/, "");
    if (srcset) out = out.replace(/(\s\/?>)$/, ` srcset="${srcset[1]}"$1`);
    if (sizes) out = out.replace(/(\s\/?>)$/, ` sizes="${sizes[1]}"$1`);
    return out.replace(/\s{2,}/g, " ");
  });
}

// The theme has two scripts, not one. The inline toggle lives in the header
// part; the back to top button, the nav close and the contact panel live in
// assets/ui.js. Breeze concatenated both into its bundle, so dropping the
// bundle dropped the second one too. Fetched from the live install rather than
// read locally, because the local theme copy goes stale after admin edits.
// LQIP: a ~1KB blurred thumbnail of each photo, inlined as a background so
// something image-shaped is there the instant the page paints and the real
// file fades in over it. Pure CSS on top of native lazy loading; no runtime.
// ImageMagick does the shrinking; the placeholder is 24px wide and the blur
// comes from the browser scaling it back up.
const { execFileSync } = require("node:child_process");
function dominantColor(file) {
  // Average the whole image down to one pixel and read it back as hex.
  const out = execFileSync("magick",
    [file, "-resize", "1x1!", "-format", "%[hex:p{0,0}]", "info:-"]).toString().trim();
  return "#" + out.slice(0, 6).toLowerCase();
}

// The loading mark is the site's own logo: the same six bars and dot from the
// header, pulsing like an equalizer while the photo streams in. SMIL, because
// SMIL runs inside SVG used as a CSS background where JavaScript cannot.
// Each bar animates height and y together so it grows from its center line.
function loadingSvg() {
  const bars = [[0, 52], [34, 76], [68, 28], [102, 92], [136, 60], [170, 40]];
  const rects = bars.map(([x, h], i) => {
    const hi = Math.round(h * 1.45);
    const y = (hh) => 60 - hh / 2;
    const begin = (i * 0.14).toFixed(2);
    return `<rect x="${x}" width="26" rx="1" height="${h}" y="${y(h)}" fill="#fff" opacity=".22">` +
      `<animate attributeName="height" values="${h};${hi};${h}" dur="1.3s" begin="${begin}s" repeatCount="indefinite" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1"/>` +
      `<animate attributeName="y" values="${y(h)};${y(hi)};${y(h)}" dur="1.3s" begin="${begin}s" repeatCount="indefinite" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1"/>` +
      `</rect>`;
  }).join("");
  const dot = `<circle cx="81" cy="60" r="5" fill="#9fd400">` +
    `<animate attributeName="opacity" values="1;.3;1" dur="1.3s" repeatCount="indefinite"/></circle>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 120">${rects}${dot}</svg>`;
}

function inlinePlaceholders(html, outDir) {
  let n = 0;
  html = html.replace(/<img\b[^>]*>/g, (tag) => {
    const m = /\ssrc="(assets\/img\/[^"]+)"/.exec(tag);
    if (!m) return tag;
    const color = dominantColor(path.join(outDir, m[1]));
    n++;
    return tag.replace(/(\s\/?>)$/,
      ` style="background:url(assets/loading.svg) center/72px auto no-repeat ${color}"$1`);
  });
  if (!n) throw new Error("no images received a placeholder");
  console.log(`inlined ${n} placeholders (logo loader over dominant color)`);
  return html;
}

async function uiScript(origin) {
  const url = origin + "/wp-content/themes/cangiano/assets/ui.js";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ui.js not reachable at ${url} (${res.status})`);
  const body = await res.text();
  if (!/scroll/.test(body)) throw new Error("ui.js fetched but does not look like the UI script");
  return body;
}

async function themeScript() {
  const part = path.join(process.env.HOME, "Documents/mc-theme/parts/header.html");
  const src = await fs.readFile(part, "utf8");
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("theme toggle script not found in " + part);
  return m[1].trim();
}

// The contact form is ours, not WordPress's. It is injected here as well as
// living in dist/ so the two can never disagree: a rebuild that scraped the
// origin would otherwise quietly drop it, and the loss would look like nothing
// at all until someone tried to send a message.
const CONTACT_SECTION = `<div class="mc-block-group is-nowrap is-layout-flex mc-container-core-group-is-layout-8e2d48a5 mc-block-group-is-layout-flex" style="margin-bottom:26px"><p class="mc-num mc-block-paragraph">07</p><h2 class="mc-block-heading" id="contact">Contact</h2></div><p class="mc-block-paragraph" style="font-size:clamp(17px, 1.5vw, 20px);line-height:1.55">Tell me what you need. I read everything that comes through here.</p><form class="mc-form" method="post" action="https://formsubmit.co/me@marccangiano.com"><div class="mc-hp" aria-hidden="true"><label for="mc-hp">Leave this empty</label><input type="text" id="mc-hp" name="_honey" tabindex="-1" autocomplete="off"></div><div class="mc-row"><div class="mc-f"><label for="mc-name">Name <span class="mc-req">*</span></label><input id="mc-name" type="text" name="name" autocomplete="name" required></div><div class="mc-f"><label for="mc-email">Email <span class="mc-req">*</span></label><input id="mc-email" type="email" name="email" autocomplete="email" spellcheck="false" required></div></div><div class="mc-f"><label for="mc-phone">Phone</label><input id="mc-phone" type="tel" name="phone" autocomplete="tel"></div><div class="mc-f"><label for="mc-message">Message</label><textarea id="mc-message" name="message" rows="6"></textarea></div><input type="hidden" name="_subject" value="marccangiano.com inquiry"><input type="hidden" name="_captcha" value="false"><button type="submit">Send</button></form>`;

const FORM_CSS = `.mc-form{display:grid;gap:22px;margin-top:26px;font-size:clamp(17px, 1.5vw, 20px);max-width:68ch}.mc-form .mc-f{display:grid;gap:9px}.mc-form .mc-row{display:grid;gap:22px;grid-template-columns:1fr 1fr}@media(max-width:640px){.mc-form .mc-row{grid-template-columns:1fr}}.mc-form label{font-family:var(--mc--preset--font-family--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mc--preset--color--muted)}.mc-form .mc-req{color:var(--mc--preset--color--accent)}.mc-form input,.mc-form textarea{width:100%;box-sizing:border-box;background:transparent;color:var(--mc--preset--color--contrast);border:1px solid var(--mc--preset--color--line);border-radius:2px;padding:13px 14px;font-family:inherit;font-size:16px;line-height:1.5;transition:border-color .2s ease}.mc-form textarea{min-height:150px;resize:vertical}.mc-form input:focus,.mc-form textarea:focus{outline:none;border-color:var(--mc--preset--color--accent)}.mc-form input:-webkit-autofill{-webkit-text-fill-color:var(--mc--preset--color--contrast);-webkit-box-shadow:0 0 0 1000px var(--mc--preset--color--base) inset}.mc-form button{justify-self:start;background:var(--mc--preset--color--accent);color:var(--mc--preset--color--base);border:1px solid var(--mc--preset--color--accent);border-radius:2px;padding:14px 30px;font-family:var(--mc--preset--font-family--mono);font-size:12px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;transition:opacity .2s ease}.mc-form button:hover,.mc-form button:focus-visible{opacity:.85}.mc-hp{position:absolute!important;left:-9999px!important;width:1px!important;height:1px!important;overflow:hidden!important}`;

function injectContact(html) {
  // Last </div></main> closes entry-content, whose constrained layout centers
  // its direct children on the content column. That is how the form picks up
  // the same measure as the prose without repeating any of its numbers.
  const anchor = "</div></main>";
  const i = html.lastIndexOf(anchor);
  if (i < 0) throw new Error("end of entry-content not found; contact form not injected");
  if (html.includes('class="mc-form"')) return html;
  return html.slice(0, i) + CONTACT_SECTION + html.slice(i);
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(ASSETS, { recursive: true });

  console.log("fetching page");
  let html = await (await fetch(ORIGIN + "/")).text();

  // CSS first: it carries its own url() references to fonts and images.
  const pageAssets = collectAssetUrls(html);
  const cssUrl = pageAssets.find((u) => u.includes("/css/"));
  let css = cssUrl ? await (await fetch(cssUrl)).text() : "";
  const all = new Set([...pageAssets, ...collectAssetUrls(css)]);

  console.log(`downloading ${all.size} assets`);
  const map = new Map();
  for (const url of all) {
    const rel = localPath(url);
    map.set(stripVer(url), rel);
    if (rel === "assets/site.css") continue; // written below, after rewriting
    if (rel === "assets/site.js") continue;   // dropped, see themeScript()
    await download(url, path.join(OUT, rel));
  }

  const rewrite = (text) => {
    for (const [url, rel] of map) {
      // Both the bare URL and any ?ver= variant point at the same file.
      const esc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Relative, not root relative. A Pages project site lives under
      // /<repo>/, where a leading slash resolves to the wrong root. The page
      // is a single file at the top level, so this works there and at the
      // domain root without a second build.
      text = text.replace(new RegExp(esc + "(\\?[^\"'\\s)]*)?", "g"), rel);
    }
    // Anything left pointing at the old origin becomes root relative.
    return text.replace(new RegExp(ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");
  };

  // A pure token rename. These custom properties are only called wp-- because
  // WordPress generated them; the values and cascade are untouched.
  const rename = (text) => text.replace(/--wp--/g, "--mc--");

  css = delayNumberDraw(americanize(renameClasses(dropEmojiRule(rename(rewrite(css))))));
  await fs.writeFile(path.join(OUT, "assets/site.css"), css + FORM_CSS);

  html = stripWordPress(html);
  html = dedupeMeta(html);
  html = renameProjects(americanize(renameClasses(rename(rewrite(html)))));
  html = delayNumberShine(html);
  if (!/begin="3\.65s"/.test(html)) throw new Error("shine delay did not apply");

  // Swap the Breeze bundle for the theme's own script.
  const toggle = await themeScript();
  const ui = await uiScript(ORIGIN);
  await fs.writeFile(path.join(OUT, "assets/ui.js"), ui);
  const before = html;
  html = html.replace(/<script[^>]*src="\/?assets\/site\.js"[^>]*><\/script>/,
    "<script>\n" + toggle + "\n</script>\n<script src=\"assets/ui.js\" defer></script>");
  if (html === before) throw new Error("script tag for the dropped bundle was not found");

  html = unlazy(html);
  if (/data-breeze|br-lazy/.test(html)) throw new Error("lazy placeholders survived unlazy()");
  if (/<img[^>]*src="data:image\/svg/.test(html)) throw new Error("an img is still a blank placeholder");
  await fs.writeFile(path.join(OUT, "assets/loading.svg"), loadingSvg());
  html = inlinePlaceholders(html, OUT);

  // Canonical has to keep the real origin or it points at nothing.
  html = html.replace(/<link rel="canonical" href="\/"/, `<link rel="canonical" href="${CANONICAL}/"`);
  html = html.replace(/(<meta property="og:url" content=")\//, `$1${CANONICAL}/`);

  html = injectContact(html);
  await fs.writeFile(path.join(OUT, "index.html"), html);

  // WordPress generated these two; nothing does now.
  await fs.writeFile(
    path.join(OUT, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${CANONICAL}/sitemap.xml\n`
  );
  await fs.writeFile(
    path.join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${CANONICAL}/</loc></url>\n</urlset>\n`
  );
  // Only with --cname. Committing this makes Pages claim the domain, which
  // redirects the github.io preview to an address still served by Cloudways,
  // so the preview stops working before the DNS cutover has happened.
  if (process.argv.includes("--cname")) {
    await fs.writeFile(path.join(OUT, "CNAME"), "marccangiano.com\n");
  }
  await fs.writeFile(path.join(OUT, ".nojekyll"), "");

  const tells = (html.match(/wp-(?!sentinel|e2e-kit)[a-z0-9-]+/g) || []);
  console.log(`wrote dist/index.html (${html.length} bytes)`);
  console.log(`remaining wp- tokens: ${tells.length}` + (tells.length ? " -> " + [...new Set(tells)].join(", ") : ""));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
