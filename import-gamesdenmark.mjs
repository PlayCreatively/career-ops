#!/usr/bin/env node

/**
 * import-gamesdenmark.mjs — Tokenless bulk-import of Danish game studios from the
 * Games Denmark directory (https://gamesdenmark.dk/work) into studios.yml as
 * `status: unresolved` backlog entries (deduped). Zero LLM tokens: a plain
 * WordPress REST fetch + HTML field mapping. The Denmark analogue to
 * import-dga.mjs (Netherlands) and import-sgda.mjs (Switzerland).
 *
 *   Source: WP REST, https://gamesdenmark.dk/wp-json/wp/v2/tmnf_project
 *           (the "Projects & Works" archive is really a studio directory —
 *           ~186 studio profiles, no auth). Each profile's content.rendered
 *           carries a consistent "Studio Details" block:
 *             <li><strong>Website:</strong> <a href="...">...</a></li>
 *             <li><strong>Email:</strong>   <a href="mailto:...">...</a></li>
 *             <li><strong>Location:</strong> street, 0000 City</li>
 *             <li><strong>Founded / Employees / CVR / Status:</strong> ...</li>
 *
 * We attach the studio's OWN domain as a `careers_url` hint so probe-studios.mjs
 * can sweep it for a custom-domain ATS (teamtailor/recruitee/personio on the
 * studio's own host). Domain comes from the Website field; when that is missing
 * we fall back to the email's domain (skipping free-mail + shared hosts), which
 * lifts coverage from ~81 to ~106 of 186. Studios with neither still import as
 * leads (city + CVR in notes) for the resolve pass.
 *
 * Because each entry is `status: unresolved`, scan.mjs skips it (no provider
 * resolves) and probe-studios/`resolve` walk it later — same lifecycle as the
 * DGA/GDI backlog. See [[studio-index-sources]].
 *
 * Usage:
 *   node import-gamesdenmark.mjs --dry-run     # fetch + print, write nothing
 *   node import-gamesdenmark.mjs               # append new studios to studios.yml
 *   node import-gamesdenmark.mjs --json F.json  # use a local REST dump (skip fetch)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

const REST = 'https://gamesdenmark.dk/wp-json/wp/v2/tmnf_project';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const STUDIOS = process.env.CAREER_OPS_STUDIOS || 'studios.yml';
const DRY = process.argv.includes('--dry-run');
const jsonFlag = process.argv.indexOf('--json');
const localJson = jsonFlag !== -1 ? process.argv[jsonFlag + 1] : null;

// Same normalisation import-dga.mjs / probe-studios.mjs use, so dedup agrees.
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(ab|aktiebolag|inc|ltd|llc|gmbh|bv|hb|as|aps|oy|studios?|games?|interactive|entertainment|group|the|productions?|media)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

// Free-mail providers: an @gmail.com address tells us nothing about a studio's
// own web host, so never derive a domain hint from these.
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.dk', 'outlook.com',
  'outlook.dk', 'live.com', 'live.dk', 'yahoo.com', 'yahoo.dk', 'icloud.com',
  'me.com', 'mac.com', 'msn.com', 'mail.com', 'gmx.com', 'gmx.net',
  'protonmail.com', 'proton.me', 'pm.me', 'aol.com',
]);

// Shared/portfolio hosts that are NOT a studio's own domain — attaching them as
// a careers_url hint would point the resolver at the wrong place.
const SHARED_HOSTS = new Set([
  'artstation.com', 'itch.io', 'github.com', 'github.io', 'behance.net',
  'wixsite.com', 'linktr.ee', 'carrd.co', 'notion.site', 'sites.google.com',
  'google.com', 'facebook.com', 'linkedin.com', 'gumroad.com', 'patreon.com',
  'youtube.com', 'instagram.com', 'x.com', 'twitter.com', 'steampowered.com',
  'store.steampowered.com', 'discord.gg', 'discord.com',
]);

// Decode the handful of HTML entities WordPress emits in these fields.
function decode(s) {
  return String(s || '')
    .replace(/&#8217;|&#039;|&#39;/g, "'")
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&#038;|&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#[0-9]+;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function registrableHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (!h || SHARED_HOSTS.has(h)) return '';
    if (/\.(wixsite\.com|github\.io|itch\.io|notion\.site)$/.test(h)) return '';
    return h;
  } catch { return ''; }
}

// Pull one studio's fields out of its rendered HTML content. The Website field is
// canonical; email-domain is the fallback for the domain hint only.
function parseStudio(post) {
  const html = post.content && post.content.rendered ? post.content.rendered : '';
  const name = decode(post.title && post.title.rendered);

  const site = html.match(/<strong>\s*Website:\s*<\/strong>\s*<a[^>]+href=["']([^"']+)["']/i)
    || html.match(/More information is available at\s*<a[^>]+href=["']([^"']+)["']/i);
  const mail = html.match(/href=["']mailto:([^"'?]+)/i);
  const loc = html.match(/<strong>\s*Location:\s*<\/strong>\s*([^<]+)</i);
  const founded = html.match(/<strong>\s*Founded:\s*<\/strong>\s*([0-9]{4})/i);
  const emp = html.match(/<strong>\s*Employees:\s*<\/strong>\s*([0-9]+)/i);
  const cvr = html.match(/<strong>\s*CVR:\s*<\/strong>\s*([0-9]+)/i);

  let host = site ? registrableHost(site[1]) : '';
  const email = mail ? decode(mail[1]).toLowerCase() : '';
  if (!host && email) {
    const dom = email.split('@')[1] || '';
    if (dom && !FREE_MAIL.has(dom) && !SHARED_HOSTS.has(dom)) host = dom.replace(/^www\./, '');
  }

  // "street, 0000 City" → City (drop the postcode). Some rows have city only.
  let city = '';
  if (loc) {
    const tail = decode(loc[1]).split(',').pop().trim();
    city = tail.replace(/^\d{3,4}\s+/, '').trim();
  }

  return {
    name,
    slug: post.slug || '',
    careers_url: host,
    email,
    city,
    founded: founded ? founded[1] : '',
    size: emp ? emp[1] : '',
    cvr: cvr ? cvr[1] : '',
  };
}

async function getPosts() {
  if (localJson) {
    if (!existsSync(localJson)) throw new Error(`JSON not found: ${localJson}`);
    return JSON.parse(readFileSync(localJson, 'utf-8'));
  }
  const all = [];
  const perPage = 100;
  for (let page = 1; page <= 20; page++) {
    const url = `${REST}?per_page=${perPage}&page=${page}&_fields=slug,title,content`;
    console.error(`Fetching ${url} ...`);
    const r = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
    if (r.status === 400) break; // WP returns 400 past the last page
    if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < perPage) break;
  }
  return all;
}

function loadExistingKeys() {
  const keys = new Set();
  if (!existsSync(STUDIOS)) return keys;
  const doc = yaml.load(readFileSync(STUDIOS, 'utf-8')) || {};
  for (const c of doc.tracked_companies || []) {
    if (c && c.name) keys.add(norm(c.name));
  }
  return keys;
}

function main(posts) {
  const studios = posts.filter(p => p && p.title && p.title.rendered).map(parseStudio).filter(s => s.name);
  const existing = loadExistingKeys();

  const fresh = [];
  const seen = new Set();
  let dupes = 0;
  for (const s of studios) {
    const key = norm(s.name);
    if (!key) continue;
    if (existing.has(key) || seen.has(key)) { dupes++; continue; }
    seen.add(key);
    fresh.push(s);
  }
  fresh.sort((a, b) => a.name.localeCompare(b.name));

  console.error(`\nGames Denmark directory import (gamesdenmark.dk/work)`);
  console.error(`  studios in feed:    ${studios.length}`);
  console.error(`  already tracked:    ${dupes}`);
  console.error(`  NEW to add:         ${fresh.length}`);
  console.error(`  with domain hint:   ${fresh.filter(f => f.careers_url).length}`);

  if (DRY) {
    for (const f of fresh) console.log(`${f.name}${f.careers_url ? '  ·  ' + f.careers_url : '  ·  (no domain)'}${f.city ? '  ·  ' + f.city : ''}`);
    console.error('\n(dry run — nothing written. Re-run without --dry-run to append.)');
    return;
  }
  if (fresh.length === 0) { console.error('Nothing new to add.'); return; }

  // Quote anything that isn't a plain-safe YAML scalar (see import-dga.mjs).
  const yamlStr = (s) => (/^[A-Za-z0-9][\w .,&'()/+-]*$/.test(s) ? s : JSON.stringify(s));
  const block = '\n  # ── Games Denmark import (gamesdenmark.dk/work) ──\n' +
    '  # Active DK studios, bulk-imported tokenlessly (import-gamesdenmark.mjs).\n' +
    '  # status: unresolved → scan.mjs skips; careers_url = own domain hint for\n' +
    '  # probe-studios/`resolve`. Domain from Website field, else email domain.\n' +
    fresh.map(f => {
      const note = [
        'Games Denmark directory',
        f.city ? f.city : null,
        f.founded ? `est. ${f.founded}` : null,
        f.size ? `~${f.size} ppl` : null,
        f.cvr ? `CVR ${f.cvr}` : null,
        !f.careers_url && f.email ? `email: ${f.email}` : null,
      ].filter(Boolean).join(' · ');
      let entry = `  - name: ${yamlStr(f.name)}\n    country: DK\n    status: unresolved\n`;
      if (f.careers_url) entry += `    careers_url: https://${f.careers_url}/\n`;
      entry += `    notes: ${JSON.stringify(note)}`;
      return entry;
    }).join('\n') + '\n';

  let file = readFileSync(STUDIOS, 'utf-8');
  if (!file.endsWith('\n')) file += '\n';
  writeFileSync(STUDIOS, file + block, 'utf-8');
  console.error(`Appended ${fresh.length} studios to ${STUDIOS}.`);
}

main(await getPosts());
