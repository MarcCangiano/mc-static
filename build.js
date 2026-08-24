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

function americanize(text) {
  for (const [re, to] of SPELLING) text = text.replace(re, to);
  return text;
}

// Breeze concatenated Marc's 25 line theme switcher into 113KB of its own
// cache and prefetch machinery, most of which checks whether the current URL
// is wp-admin. None of that means anything on a static host, so the bundle is
// dropped and the theme's own script is inlined from the theme source.
async function themeScript() {
  const part = path.join(process.env.HOME, "Documents/mc-theme/parts/header.html");
  const src = await fs.readFile(part, "utf8");
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("theme toggle script not found in " + part);
  return m[1].trim();
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
      text = text.replace(new RegExp(esc + "(\\?[^\"'\\s)]*)?", "g"), "/" + rel);
    }
    // Anything left pointing at the old origin becomes root relative.
    return text.replace(new RegExp(ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");
  };

  // A pure token rename. These custom properties are only called wp-- because
  // WordPress generated them; the values and cascade are untouched.
  const rename = (text) => text.replace(/--wp--/g, "--mc--");

  css = americanize(renameClasses(rename(rewrite(css))));
  await fs.writeFile(path.join(OUT, "assets/site.css"), css);

  html = stripWordPress(html);
  html = dedupeMeta(html);
  html = renameProjects(americanize(renameClasses(rename(rewrite(html)))));

  // Swap the Breeze bundle for the theme's own script.
  const toggle = await themeScript();
  html = html.replace(/<script[^>]*src="\/assets\/site\.js"[^>]*><\/script>/,
    "<script>\n" + toggle + "\n</script>");

  // Canonical has to keep the real origin or it points at nothing.
  html = html.replace(/<link rel="canonical" href="\/"/, `<link rel="canonical" href="${CANONICAL}/"`);
  html = html.replace(/(<meta property="og:url" content=")\//, `$1${CANONICAL}/`);

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
  await fs.writeFile(path.join(OUT, "CNAME"), "marccangiano.com\n");
  await fs.writeFile(path.join(OUT, ".nojekyll"), "");

  const tells = (html.match(/wp-(?!sentinel|e2e-kit)[a-z0-9-]+/g) || []);
  console.log(`wrote dist/index.html (${html.length} bytes)`);
  console.log(`remaining wp- tokens: ${tells.length}` + (tells.length ? " -> " + [...new Set(tells)].join(", ") : ""));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
