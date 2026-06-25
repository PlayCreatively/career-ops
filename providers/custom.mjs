// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Custom provider — the Tier-2 catch-all for homemade careers pages that no
// shared ATS provider covers. It executes a DECLARATIVE `recipe:` captured (once)
// during a manual/browser pass, so every later scan replays it for zero tokens.
//
// The recipe is DATA, not code — it lives in the studios.yml entry, runs through
// the same provider seam as greenhouse/lever, and is testable. When a site is too
// weird to express declaratively, drop to Tier 3 (`parser:` → providers/local-parser.mjs,
// a script file); when it can't be scraped at all, tag it (kind: blocked|browser)
// and the resolver skips it.
//
// ── Recipe kinds ────────────────────────────────────────────────────
//
//   json    — site fetches its own JSON (Network tab → XHR). Best case: robust,
//             zero-dep, survives CSS redesigns.
//   html    — server-rendered HTML; extract via a small CSS-subset selector.
//             Best-effort (flat repeated blocks); escalate to a `parser:` script
//             if the page is nested/complex.
//   blocked — bot-stopper / no machine feed. Tag only; NOT scanned.
//   browser — needs a Playwright pass by the agent. Tag only; NOT scanned here.
//   unresolved — backlog placeholder, not yet researched. NOT scanned.
//
// Only json/html are claimed by detect(); the rest are inert tags that keep the
// company visible in studios.yml without scan.mjs trying to fetch them.
//
// ── Schema ──────────────────────────────────────────────────────────
//
//   - name: Some Studio
//     provider: custom            # optional — a recipe auto-routes here too
//     careers_url: https://somestudio.com/careers
//     recipe:
//       kind: json
//       endpoint: https://somestudio.com/api/openings   # required for json
//       method: GET                                      # optional (GET default)
//       list_path: data.jobs                             # dot-path to the array ('' = root)
//       fields:                                          # dot-paths into each item
//         title: position.title
//         url: applyUrl                                  # or omit + use url_template
//         location: office.city
//         company: studio.name                           # optional (falls back to name)
//       url_template: https://somestudio.com/jobs/{id}   # optional, {field} from item
//       url_base: https://somestudio.com                 # optional, resolves relative urls
//
//   - name: Another Studio
//     recipe:
//       kind: html
//       endpoint: https://anotherstudio.com/jobs   # optional (careers_url used if absent)
//       list_selector: ".vacancy"                  # repeated container, one per job
//       fields:
//         title: "h3"                              # text of first match
//         url: "a@href"                            # attribute of first match
//         location: ".loc"
//       url_base: https://anotherstudio.com

const SCANNABLE_KINDS = new Set(['json', 'html']);

// ── Shared helpers ──────────────────────────────────────────────────

function getPath(obj, path) {
  if (path == null || path === '') return obj;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function normalizeJobUrl(rawUrl, baseUrl) {
  if (!rawUrl) return '';
  try {
    return new URL(String(rawUrl).trim(), baseUrl || undefined).href;
  } catch {
    return '';
  }
}

function normalizeLocation(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(normalizeLocation).filter(Boolean).join(', ');
  if (typeof value === 'object') return String(value.name || value.text || value.city || '').trim();
  return String(value).trim();
}

// Expand `{field}` placeholders in a url_template from item paths.
function expandUrlTemplate(template, item) {
  return String(template).replace(/\{([^}]+)\}/g, (_, key) => {
    const v = getPath(item, key.trim());
    return v == null ? '' : String(v);
  });
}

// ── JSON recipe ─────────────────────────────────────────────────────

export function parseJsonRecipe(payload, recipe, entry) {
  const arr = getPath(payload, recipe.list_path);
  if (!Array.isArray(arr)) {
    throw new Error(
      `custom: list_path "${recipe.list_path || '(root)'}" did not resolve to an array for ${entry.name}`,
    );
  }
  const f = recipe.fields || {};
  const out = [];
  for (const item of arr) {
    if (item == null || typeof item !== 'object') continue;
    const title = String(getPath(item, f.title) ?? '').trim();
    let url = f.url ? getPath(item, f.url) : '';
    if (!url && recipe.url_template) url = expandUrlTemplate(recipe.url_template, item);
    url = normalizeJobUrl(url, recipe.url_base || entry.careers_url);
    if (!title || !url) continue;
    const company = (f.company ? String(getPath(item, f.company) ?? '').trim() : '') || entry.name || '';
    out.push({ title, url, company, location: normalizeLocation(f.location ? getPath(item, f.location) : '') });
  }
  return out;
}

// ── HTML recipe (best-effort CSS subset) ────────────────────────────
// Supports a single compound selector: optional tag + .class(es) + #id +
// [attr] / [attr=value]. No descendant combinators — match within each block.
// Field selectors add an optional `@attr` suffix to read an attribute instead
// of text. This deliberately covers the common "list of flat cards" shape; for
// nested/complex markup, use a Tier-3 `parser:` script.

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSelector(sel) {
  let rest = String(sel || '').trim();
  let attr = null;
  rest = rest.replace(/\[([a-zA-Z0-9_:-]+)(?:=["']?([^"'\]]*)["']?)?\]/, (_, n, v) => {
    attr = { name: n, value: v };
    return '';
  });
  const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : '';
  const classes = [...rest.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
  const idMatch = rest.match(/#([\w-]+)/);
  const id = idMatch ? idMatch[1] : '';
  return { tag, id, classes, attr };
}

function openTagRegex(tag) {
  return new RegExp(`<(${tag || '[a-zA-Z][\\w-]*'})\\b([^>]*)>`, 'gi');
}

function attrsMatch(attrsStr, sel) {
  if (sel.id && !new RegExp(`\\bid\\s*=\\s*["']?[^"'>]*\\b${escapeReg(sel.id)}\\b`, 'i').test(attrsStr)) return false;
  for (const cls of sel.classes) {
    if (!new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${escapeReg(cls)}\\b`, 'i').test(attrsStr)) return false;
  }
  if (sel.attr) {
    const a = sel.attr;
    if (a.value) {
      if (!new RegExp(`\\b${escapeReg(a.name)}\\s*=\\s*["']?${escapeReg(a.value)}["'\\s>]`, 'i').test(attrsStr + ' ')) return false;
    } else if (!new RegExp(`\\b${escapeReg(a.name)}\\b`, 'i').test(attrsStr)) {
      return false;
    }
  }
  return true;
}

function getAttr(attrsStr, name) {
  const m = attrsStr.match(new RegExp(`\\b${escapeReg(name)}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!m) return '';
  return (m[2] ?? m[3] ?? m[4] ?? '').trim();
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

// Split the document into one block per list_selector match (block = from a
// match start to the next match start). Approximate but reliable for flat lists.
function findBlocks(html, listSelector) {
  const sel = parseSelector(listSelector);
  const re = openTagRegex(sel.tag);
  const starts = [];
  let m;
  while ((m = re.exec(html))) {
    if (attrsMatch(m[2], sel)) starts.push({ index: m.index });
    if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width
  }
  return starts.map((s, i) => ({
    html: html.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : html.length),
  }));
}

function extractField(block, fieldSel) {
  if (!fieldSel) return stripTags(block);
  let sel = String(fieldSel);
  let attr = null;
  const at = sel.split('@');
  if (at.length === 2) { sel = at[0].trim(); attr = at[1].trim(); }

  // "@attr" with no selector → attribute of the block's own opening tag
  if (sel === '' && attr) {
    const open = block.match(/^<[^>]*>/);
    return open ? getAttr(open[0], attr) : '';
  }

  const s = parseSelector(sel);
  const re = openTagRegex(s.tag);
  let m;
  while ((m = re.exec(block))) {
    if (!attrsMatch(m[2], s)) continue;
    if (attr) return getAttr(m[2], attr);
    const after = block.slice(m.index + m[0].length);
    if (s.tag) {
      const close = new RegExp(`</${s.tag}\\s*>`, 'i').exec(after);
      return stripTags(close ? after.slice(0, close.index) : after.slice(0, 500));
    }
    const lt = after.indexOf('<');
    return stripTags(lt === -1 ? after : after.slice(0, lt));
  }
  return '';
}

export function parseHtmlRecipe(html, recipe, entry) {
  if (!recipe.list_selector) throw new Error(`custom: html recipe needs list_selector for ${entry.name}`);
  const f = recipe.fields || {};
  const base = recipe.url_base || entry.careers_url;
  const out = [];
  for (const block of findBlocks(html, recipe.list_selector)) {
    const title = extractField(block.html, f.title);
    const url = normalizeJobUrl(extractField(block.html, f.url), base);
    if (!title || !url) continue;
    out.push({
      title,
      url,
      company: (f.company ? extractField(block.html, f.company) : '') || entry.name || '',
      location: f.location ? extractField(block.html, f.location) : '',
    });
  }
  return out;
}

// ── Provider ────────────────────────────────────────────────────────

/** @type {Provider} */
export default {
  id: 'custom',

  // Claim any entry carrying a scannable recipe. blocked/browser/unresolved
  // recipes return null so scan.mjs leaves them in the backlog untouched.
  detect(entry) {
    const r = entry.recipe;
    if (!r || typeof r !== 'object' || !SCANNABLE_KINDS.has(r.kind)) return null;
    const src = r.endpoint || entry.careers_url;
    return src ? { url: src } : null;
  },

  async fetch(entry, ctx) {
    const r = entry.recipe || {};
    if (r.kind === 'json') {
      const endpoint = r.endpoint || entry.careers_url;
      if (!endpoint) throw new Error(`custom: json recipe needs endpoint (or careers_url) for ${entry.name}`);
      const opts = { redirect: 'follow' };
      if (r.method) opts.method = String(r.method).toUpperCase();
      if (r.body != null) opts.body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      if (r.headers && typeof r.headers === 'object') opts.headers = r.headers;
      const json = await ctx.fetchJson(endpoint, opts);
      return parseJsonRecipe(json, r, entry);
    }
    if (r.kind === 'html') {
      const url = r.endpoint || entry.careers_url;
      if (!url) throw new Error(`custom: html recipe needs endpoint (or careers_url) for ${entry.name}`);
      const opts = { redirect: 'follow' };
      if (r.headers && typeof r.headers === 'object') opts.headers = r.headers;
      const html = await ctx.fetchText(url, opts);
      return parseHtmlRecipe(html, r, entry);
    }
    throw new Error(`custom: unsupported recipe kind "${r.kind}" for ${entry.name}`);
  },
};
