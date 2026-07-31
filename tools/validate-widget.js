#!/usr/bin/env node
// Standards validator for Waveshare widgets — the single validation boundary the
// build-widget skill, humans, and imports all share (see docs/WIDGET-STANDARD.md).
//
//   node tools/validate-widget.js widgets/clock           one widget, human output
//   node tools/validate-widget.js --all widgets           every widget, summary
//   node tools/validate-widget.js --json widgets/clock    machine-readable report
//
// Exit code 0 = no errors (warnings allowed), 1 = errors found or unreadable input.
// Every failure carries a stable rule id so automated repair loops can react.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const KNOWN_TYPES = new Set(['text', 'number', 'slider', 'color', 'select', 'switch',
  'secret', 'sensor', 'sensors-factory', 'location', 'list', 'media-selector']);
// Names that look like credentials: declaring them as free text writes a plaintext
// secret into layout.json, so the validator flags the type, not the widget author.
// camelCase and PascalCase count — `apiToken`, `clientSecret`, `githubPAT`, `APIToken`
// are the COMMON spellings, so the name is split at case boundaries before matching.
// The compound keywords tolerate the break the splitter introduces: "OAuthAPIKey"
// becomes "O Auth API Key", and "API Key" is still an api key.
// The trailing `s?` matters: `credential` was flagged and `credentials` was not, which
// the shared fixture caught. It cannot swallow the boundary cases — `passwordless`,
// `secretary` and `tokenizer` still fail, because after the optional s the next
// character must end the word.
const CREDENTIAL_WORD = /(^|[^a-z0-9])(token|secret|password|passwd|api ?key|bearer|pat|credential|private ?key|access ?key|authorization|auth ?header|jwt|pass ?phrase)s?([^a-z0-9]|$)/i;
// Credential-equivalent URLs (WIDGET-STANDARD: "a private ICS or webhook link"). A
// webhook URL IS the credential — anyone holding it can post. So is a private calendar
// address. But most url properties are public (the iframe and youtube widgets both
// ship one), so a bare url/link/endpoint is never enough on its own: it takes a
// secrecy qualifier, or webhook in a form that names the VALUE rather than
// configuration about it — `webhookUrl` and `slackWebhook` hold the secret;
// `webhookEnabled` and `webhookMethod` are a switch and a verb.
const WEBHOOK = /(^|[^a-z0-9])web ?hook([^a-z0-9]|$)/i;
const WEBHOOK_VALUE = /web ?hook$/i;
// All-lowercase compounds have no case boundary to split on and no word boundary to
// match, so `apitoken` and `clientsecret` slipped through the boundary-based rules
// entirely. These pairs are credential-bearing with no plausible innocent reading.
// Anchored at the END: unanchored, `userKeyboardLayout` squashes to
// `userkeyboardlayout` and matches `userkey`, failing a keyboard-layout select.
const COMPOUND = /(api|client|access|auth|refresh|session|bearer|private|user|admin|service|oauth)(token|secret|key|password|passwd)s?$/i;
// ...but the anchor only earns that when the name HAS a boundary to reason about.
// `apiTokenValue` splits to "api Token Value" and CREDENTIAL_WORD catches the standalone
// "Token"; `apitokenvalue` splits to nothing, so the anchored rule sees a compound in
// the middle and waves it through — a plaintext token in layout.json (issue #107).
// For an all-lowercase run there is no honest way to tell `apitokenvalue` from
// `userkeyboardlayout` without a dictionary, so around credentials the ambiguous name
// is refused: an author who means the keyboard one writes `userKeyboardLayout`, which
// is the spelling the rest of this rule is built around anyway.
const COMPOUND_ANYWHERE = /(api|client|access|auth|refresh|session|bearer|private|user|admin|service|oauth)(token|secret|key|password|passwd)s?/i;
const UNSTRUCTURED = /^[a-z0-9]+$/;
// A url/link/endpoint is the credential only when the name denotes the VALUE. Same
// distinction the webhook rule makes: `privateIcsUrl` holds it, `signedUrlExpiry`
// holds a duration and `personalLinkLabel` holds a caption.
const URL_VALUE = /(url|uri|link|endpoint|address|feed)$/i;
const URLISH = /(^|[^a-z0-9])(url|uri|link|endpoint|address|feed)([^a-z0-9]|$)/i;
const SECRET_QUALIFIER = /(^|[^a-z0-9])(private|secret|signed|personal|sas)([^a-z0-9]|$)/i;
// A name ENDING in one of these describes something ABOUT a credential rather than
// holding one: `tokenEndpoint` is a public OAuth URL, `tokenExpiry` a duration,
// `accessTokenType` a string like "Bearer". Without this an ordinary OAuth widget is
// refused outright unless it declares a public URL as `secret`, which would be a lie.
// Only the credential-WORD rules are waived — the webhook and signed-URL rules still
// run below, because `webhookEndpoint` genuinely IS the credential.
// Deliberately tight: every entry must be a word that cannot itself hold the secret.
// `value`, `url` and `name` are absent for that reason — `tokenValue` and `secretUrl`
// stay flagged.
const METADATA_TAIL = /(^|[^a-z0-9])(endpoints?|expiry|expires|expiration|ttl|lifetime|type|label|format|algorithm|issuer|scopes?|count|prefix|enabled)$/i;
const looksLikeCredential = (name) => {
  // Two case boundaries, because initialisms are everywhere in this domain:
  //   acronym->word  "APIToken" -> "API Token", "JWTToken" -> "JWT Token"
  //   word->Word     "apiToken" -> "api Token", "githubPAT" -> "github PAT"
  // Separators join in ("access_key" -> "access key"), and the squashed form is tried
  // too so a two-word spelling of a one-word keyword ("access key" -> "accesskey")
  // still matches. Word boundaries keep the squashed pass honest: "compatMode" ->
  // "compatmode" does NOT match "pat", and "PATH" -> "path" does not either.
  const spaced = String(name || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ');
  const squashed = spaced.replace(/\s+/g, '');
  const trimmed = spaced.trim();
  // Metadata about a credential is not the credential; see METADATA_TAIL.
  if (!METADATA_TAIL.test(trimmed)) {
    if (CREDENTIAL_WORD.test(spaced) || CREDENTIAL_WORD.test(squashed)) return true;
    if (COMPOUND.test(squashed)) return true;
    if (UNSTRUCTURED.test(String(name || '')) && COMPOUND_ANYWHERE.test(squashed)) return true;
  }
  if (WEBHOOK.test(spaced) && (URLISH.test(spaced) || WEBHOOK_VALUE.test(trimmed))) return true;
  return URLISH.test(spaced) && SECRET_QUALIFIER.test(spaced) && URL_VALUE.test(trimmed);
};
// One attribute reader for every rule below, because the rules that rolled their own
// each missed a different legal spelling. An attribute starts at whitespace or the
// self-closing slash — NOT at any word boundary, or `data-rel` and `aria-rel` read as
// `rel` and a stylesheet slips past the ordering rule (issue #121). Values may be
// double-quoted, single-quoted, or unquoted: all three are valid HTML, and only the
// first two were being matched. Returns null when the attribute is absent, so callers
// can tell that apart from an empty value.
const attr = (tag, name) => {
  const m = tag.match(new RegExp('[\\s/]' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const APP_PREFIX = 'https://app.wsw/';
// External = anything carrying a scheme or protocol-relative authority that is not the
// shell's own origin. A plain relative path stays inside the widget's virtual host and
// is always fine.
const isExternalRef = (value) => {
  const s = String(value || '').trim();
  if (!s || s.startsWith(APP_PREFIX)) return false;
  return s.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(s);
};
const KNOWN_SLOTS = new Set(['quarter', 'half', 'three-quarter', 'full']);
const LIST_FIELD_TYPES = new Set(['text', 'color']);
// Labels must never teach a syntax — structured values use the list type.
const SYNTAX_IN_LABEL = /comma[ -]?separated|semicolon|delimited|one per line|json|\w+=\w+/i;

function validate(folder) {
  const report = { folder, ok: true, errors: [], warnings: [], externalHosts: [] };
  const err = (rule, detail) => { report.ok = false; report.errors.push({ rule, detail }); };
  const warn = (rule, detail) => { report.warnings.push({ rule, detail }); };

  // ---- manifest -----------------------------------------------------------------
  const manifestPath = path.join(folder, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    err('manifest-parse', manifestPath + ': ' + e.message);
    return report;
  }

  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id || ''))
    err('manifest-id', `id "${manifest.id}" must be reverse-DNS, lowercase (e.g. com.example.my-widget)`);
  for (const key of ['name', 'author', 'description'])
    if (typeof manifest[key] !== 'string' || !manifest[key].trim())
      err('manifest-' + key, `"${key}" is required`);
  if (!/^\d+\.\d+\.\d+([-+].+)?$/.test(manifest.version || ''))
    err('manifest-version', `version "${manifest.version}" must be semver (x.y.z)`);
  if (typeof manifest.min_api_version !== 'number')
    err('manifest-api', 'min_api_version (number) is required');
  const slots = manifest.supported_slots;
  if (!Array.isArray(slots) || !slots.length)
    err('manifest-slots', 'supported_slots must be a non-empty array');
  else for (const s of slots)
    if (!KNOWN_SLOTS.has(s)) err('manifest-slots', `unknown slot "${s}"`);

  for (const prop of manifest.properties || []) {
    const where = `property "${prop.name || '?'}"`;
    if (!prop.name) err('prop-name', 'a property is missing "name"');
    const type = prop.type || 'text';
    if (!KNOWN_TYPES.has(type)) err('prop-type', `${where}: unknown type "${type}"`);
    if (SYNTAX_IN_LABEL.test(prop.label || ''))
      err('prop-label-syntax', `${where}: label "${prop.label}" teaches a syntax — use type "list" (or a better label); users never type delimited data`);
    // Credentials MUST be type "secret": that is the only type the host encrypts
    // (DPAPI, CurrentUser) before writing layout.json. As "text" the token sits on
    // disk in the clear and rides any layout copy off the machine.
    if (type !== 'secret' && looksLikeCredential(prop.name))
      err('prop-secret', `${where}: a credential must use type "secret" (the host encrypts those with DPAPI); "${type}" stores it as plaintext in layout.json`);
    if (type === 'secret' && prop.default != null && String(prop.default) !== '')
      err('prop-secret-default', `${where}: a secret must not ship a default value`);
    if (type === 'select' && !Array.isArray(prop.options) && !prop.optionsSource)
      err('prop-select', `${where}: select needs "options" or "optionsSource"`);
    if (type === 'slider' && (typeof prop.min !== 'number' || typeof prop.max !== 'number'))
      err('prop-slider', `${where}: slider needs numeric min/max`);
    if (type === 'list') {
      if (!Array.isArray(prop.fields) || !prop.fields.length)
        err('prop-list', `${where}: list needs a "fields" array`);
      else for (const f of prop.fields) {
        if (!f.key) err('prop-list', `${where}: a list field is missing "key"`);
        // There is no encrypted list field: the host seals only top-level `secret`
        // properties, so a credential inside a list row lands in layout.json as
        // plaintext no matter what the outer property is called.
        if (f.key && looksLikeCredential(f.key))
          err('prop-secret', `${where}: list field "${f.key}" looks like a credential, and list rows are NEVER encrypted — give the widget a top-level "secret" property instead`);
        if (!LIST_FIELD_TYPES.has(f.type || 'text'))
          err('prop-list', `${where}: list field type "${f.type}" not supported (text | color)`);
      }
    }
  }

  // ---- index.html ---------------------------------------------------------------
  const htmlPath = path.join(folder, 'index.html');
  let html;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (e) {
    err('html-missing', 'index.html is required');
    return report;
  }

  // The foundation stylesheet, linked before any widget CSS.
  const baseIdx = html.indexOf('https://app.wsw/widget-base.css');
  if (baseIdx < 0) {
    err('base-css', 'index.html must link https://app.wsw/widget-base.css (first, in <head>)');
  } else {
    // The foundation must be the FIRST stylesheet of any kind — a linked local
    // stylesheet before it would override base layout just like an inline <style>.
    // The rel VALUE is parsed to its attribute boundary (quotes or whitespace) and
    // token-matched, so a preload whose filename merely contains "stylesheet"
    // (rel=preload href=stylesheet.css) cannot false-positive.
    let firstOther = html.search(/<style[\s>]/i);
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      if (m[0].includes('widget-base.css')) continue;
      const value = attr(m[0], 'rel') || '';
      if (!value.toLowerCase().split(/\s+/).includes('stylesheet')) continue;
      if (firstOther < 0 || m.index < firstOther) firstOther = m.index;
    }
    if (firstOther >= 0 && firstOther < baseIdx)
      err('base-css-order', 'widget-base.css must be the FIRST stylesheet — before any <style> or <link rel="stylesheet">');
  }

  // Tokens, never literal colors: hex colors inside <style> are the tell. Pure
  // black/white are allowed only for shadow/scrim alphas via rgba() — flagged
  // separately below.
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const noComments = styleBlocks.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of noComments.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    err('hardcoded-color', `hex literal ${m[0]} in <style> — use a design token (var(--…)); see WIDGET-STANDARD §1`);
  }
  for (const m of noComments.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const mono = r === g && g === b && (r === 0 || r === 255);
    if (!mono)
      err('hardcoded-color', `literal ${m[0]}…) in <style> — compose from tokens (rgba(var(--surface-rgb), …)) instead`);
  }

  // Self-contained: no external scripts or stylesheets (embeds/iframes and data
  // fetches are widget business; script execution from third parties is not).
  //
  // Stated as what is ALLOWED, not as what is forbidden. The forbidden list only ever
  // covered the shapes someone thought of: `//evil.example/pwn.js` is not `http://`, so
  // it passed — and a browser resolves it against the widget's own https virtual host,
  // which is precisely the fetch the rule exists to stop (issue #110). Same for `data:`,
  // `blob:`, an uppercase scheme, or a value padded with whitespace. Anything that is
  // not app.wsw and not a plain relative path is external, whatever it looks like.
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(m[0], 'src');
    if (src !== null && isExternalRef(src))
      err('external-script', `external <script src="${src}"> — widgets must be self-contained (only app.wsw scripts allowed)`);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = attr(m[0], 'href');
    if (href !== null && isExternalRef(href))
      err('external-style', `external stylesheet ${href} — bundle styles in the widget`);
  }

  // Informational: which external hosts the widget's code mentions.
  const hostSet = new Set();
  for (const m of html.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = m[1].toLowerCase();
    if (!host.endsWith('.wsw') && host !== 'app.wsw') hostSet.add(host);
  }
  report.externalHosts = [...hostSet].sort();

  // Dangerous sinks.
  if (/\beval\s*\(|new\s+Function\s*\(/.test(html))
    err('eval', 'eval() / new Function() are banned');
  if (/setInterval\s*\([^)]*,\s*([0-9]{1,2})\s*\)/.test(html))
    warn('fast-timer', 'setInterval under 100ms — this runs 24/7 on the panel; batch or slow it down');

  // bgStyle contract: widgets that offer the setting must map it to the base classes,
  // with solid as the fallback for unset/out-of-spec values.
  const hasBgStyle = (manifest.properties || []).some((p) => p.name === 'bgStyle');
  if (hasBgStyle && !/bg-solid/.test(html))
    err('bgstyle-mapping', 'bgStyle property declared but bg-solid is never applied — unset values must render solid (see the stock clock)');

  // Reduced motion: infinite animations should freeze under prefers-reduced-motion.
  if (/animation[^;]*infinite/.test(noComments) && !/prefers-reduced-motion/.test(noComments))
    warn('reduced-motion', 'infinite animation without a prefers-reduced-motion guard (widget-base.css covers its own classes only)');

  return report;
}

function human(report) {
  const lines = [`${report.ok ? 'OK  ' : 'FAIL'} ${report.folder}`];
  for (const e of report.errors) lines.push(`  ERROR   [${e.rule}] ${e.detail}`);
  for (const w of report.warnings) lines.push(`  warning [${w.rule}] ${w.detail}`);
  if (report.externalHosts.length) lines.push(`  external hosts: ${report.externalHosts.join(', ')}`);
  return lines.join('\n');
}

// ---- CLI ------------------------------------------------------------------------
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const all = args.includes('--all');

// --self-test runs the shared fixture through looksLikeCredential. The same file is
// read by the C# port at the install boundary (issue #57), and CI runs both: that is
// the only thing stopping the two from drifting into "the validator refuses this
// widget but the host installs it anyway".
if (args.includes('--self-test')) {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'credential-names.json'), 'utf8'));
  let bad = 0;
  for (const name of fixture.credential) {
    if (!looksLikeCredential(name)) { console.log(`  FAIL credential "${name}" was NOT flagged`); bad++; }
  }
  for (const name of fixture.innocent) {
    if (looksLikeCredential(name)) { console.log(`  FAIL innocent "${name}" WAS flagged`); bad++; }
  }
  const total = fixture.credential.length + fixture.innocent.length;
  console.log(bad
    ? `${bad} of ${total} disagree with tools/credential-names.json`
    : `credential rule agrees with the fixture on all ${total} names`);

  // The HTML rules get the same treatment, because both of the ways they leaked were
  // spellings nobody had written down: a browser-legal shape the regex did not model
  // (issues #110, #121). The CLEAN case is not decoration — it is what fails first if
  // one of these rules is tightened into refusing ordinary widgets.
  const BASE = '<link rel="stylesheet" href="https://app.wsw/widget-base.css">';
  const doc = (head) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>T</title>${head}<style>body { color: var(--text); }</style></head>
<body><script src="https://app.wsw/widget-api.js"></script></body></html>`;
  const htmlCases = [
    ['clean', doc(BASE), null],
    // #121 — \b matches after a hyphen, so data-rel was read as the real rel and the
    // stylesheet ahead of the base went unseen.
    ['rel-after-data-rel', doc('<link data-rel="preload" rel="stylesheet" href="local.css">' + BASE), 'base-css-order'],
    // #110 — none of these are `http://`, and all four load remote script in a browser.
    ['protocol-relative', doc(BASE + '<script src="//evil.example/pwn.js"></script>'), 'external-script'],
    ['unquoted-attribute', doc(BASE + '<script src=https://evil.example/pwn.js></script>'), 'external-script'],
    ['uppercase-scheme', doc(BASE + '<script src="HTTPS://evil.example/pwn.js"></script>'), 'external-script'],
    ['data-uri', doc(BASE + '<script src="data:text/javascript,alert(1)"></script>'), 'external-script'],
    ['external-stylesheet', doc(BASE + '<link rel="stylesheet" href="//evil.example/x.css">'), 'external-style'],
    // ...while a relative script is the ordinary case and must stay accepted.
    ['relative-script', doc(BASE + '<script src="./helper.js"></script>'), null],
  ];
  const manifest = {
    id: 'ww.selftest.fixture', name: 'Fixture', author: 'WW', description: 'self-test',
    version: '1.0.0', min_api_version: 1, supported_slots: ['quarter'], properties: [],
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-validate-'));
  let htmlBad = 0;
  for (const [name, body, expected] of htmlCases) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.html'), body);
    const rules = validate(dir).errors.map((e) => e.rule);
    if (expected === null && rules.length) {
      console.log(`  FAIL html "${name}" should validate, but raised ${rules.join(', ')}`); htmlBad++;
    } else if (expected !== null && !rules.includes(expected)) {
      console.log(`  FAIL html "${name}" should raise ${expected}, raised ${rules.join(', ') || 'nothing'}`); htmlBad++;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(htmlBad
    ? `${htmlBad} of ${htmlCases.length} html rule cases disagree`
    : `html rules agree with all ${htmlCases.length} cases`);
  process.exit(bad || htmlBad ? 1 : 0);
}

const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) {
  console.error('usage: validate-widget.js [--json] <widget-folder>  |  [--json] --all <widgets-dir>');
  process.exit(1);
}

let folders = targets;
if (all) {
  folders = [];
  for (const dir of targets) {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      if (fs.existsSync(path.join(f, 'manifest.json'))) folders.push(f);
    }
  }
}

const reports = folders.map(validate);
if (asJson) console.log(JSON.stringify(all ? reports : reports[0], null, 1));
else console.log(reports.map(human).join('\n'));
process.exit(reports.every((r) => r.ok) ? 0 : 1);
