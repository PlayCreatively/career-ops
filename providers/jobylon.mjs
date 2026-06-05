// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Jobylon provider — Jobylon (a Nordic ATS) has no keyless JSON job feed (its
// documented Feed API needs a per-customer hash), but every Jobylon career page
// is driven by a PUBLIC, keyless embed widget served from a fixed CDN host:
//
//   https://cdn.jobylon.com/jobs/companies/<id>/embed/v1/?target=x&page_size=100
//
// `<id>` is the company's numeric Jobylon id (visible in its public board URL
// https://emp.jobylon.com/companies/<id>-<slug>/). The v1 embed returns a JS
// blob that inlines the rendered job list as HTML; we parse the job <div>s out
// of it. The fetch host is hard-pinned to cdn.jobylon.com, so a tracked entry's
// careers_url can only ever select the company id — never the host (SSRF-safe).
//
// Configure explicitly (the careers_url carries the id):
//
//   - name: NOID
//     provider: jobylon
//     careers_url: https://emp.jobylon.com/companies/2048-noid/
//
// or with an explicit id:
//
//   - name: NOID
//     provider: jobylon
//     company_id: 2048

const EMBED_HOST = 'https://cdn.jobylon.com';
const PAGE_SIZE = 100;

// Resolve the company id from an explicit `company_id` or the careers_url path
// (.../companies/<id>-<slug>/). Returns a digit string or null.
export function resolveCompanyId(entry) {
  if (entry && (typeof entry.company_id === 'string' || typeof entry.company_id === 'number')) {
    const id = String(entry.company_id).trim();
    if (/^\d+$/.test(id)) return id;
  }
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== 'emp.jobylon.com' && host !== 'www.jobylon.com' && host !== 'jobylon.com') return null;
  const m = parsed.pathname.match(/\/companies\/(\d+)(?:-|\/|$)/);
  return m ? m[1] : null;
}

function embedUrl(id) {
  return `${EMBED_HOST}/jobs/companies/${id}/embed/v1/?target=x&page_size=${PAGE_SIZE}`;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Parse a Jobylon v1 embed JS blob. Exported for unit tests.
 *
 * The blob escapes the HTML payload for a JS string literal (\" \/ \uXXXX). We
 * unescape, then split on each job container `<div id="jobylon-job-<id>" ...>`.
 * Per job: title from `.jobylon-job-title`, location from `.jobylon-location`
 * (stripping its bold label), public URL synthesised as emp.jobylon.com/jobs/<id>/.
 *
 * @param {string} js
 * @param {string} companyName
 * @returns {Array<{title:string,url:string,company:string,location:string}>}
 */
export function parseJobylonEmbed(js, companyName) {
  if (typeof js !== 'string' || !js) return [];
  const html = js
    .replace(/\\u002[dD]/g, '-')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n|\\t|\\r/g, '');
  const jobs = [];
  const parts = html.split(/<div id="jobylon-job-(\d+)"/).slice(1);
  // parts = [id0, chunk0, id1, chunk1, ...]
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const id = parts[i];
    const chunk = parts[i + 1];
    const titleM = chunk.match(/class="jobylon-job-title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const title = titleM ? decodeEntities(titleM[1].replace(/<[^>]+>/g, ' ')) : '';
    if (!title) continue;
    const locM = chunk.match(/class="jobylon-location"[^>]*>([\s\S]*?)<\/li>/);
    let location = '';
    if (locM) location = decodeEntities(locM[1].replace(/<strong>[\s\S]*?<\/strong>/g, '').replace(/<[^>]+>/g, ' '));
    jobs.push({ title, url: `https://emp.jobylon.com/jobs/${id}/`, company: companyName || '', location });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'jobylon',

  detect(entry) {
    const id = resolveCompanyId(entry);
    return id ? { url: embedUrl(id) } : null;
  },

  async fetch(entry, ctx) {
    const id = resolveCompanyId(entry);
    if (!id) throw new Error(`jobylon: cannot resolve company id for ${entry.name} — set company_id or an emp.jobylon.com/companies/<id>-... careers_url`);
    const js = await ctx.fetchText(embedUrl(id), { redirect: 'error' });
    return parseJobylonEmbed(js, entry.name);
  },
};
