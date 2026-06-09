/*
 * rank.browser.js — the pure scoring core of rank.mjs, ported verbatim to the
 * browser. NO build step, NO modules (so it loads from file:// too): it just
 * defines plain functions and hangs them off `window.Rank`.
 *
 * This mirrors the exported functions of rank.mjs 1:1 — combineWeights,
 * keyToRegExp, matchSpan, scoreCategory, normalizeWeights, scoreJob, rankJobs —
 * so the board ranks jobs with the EXACT same maximal-munch / word-stem logic
 * the Node scanner uses. If you change the scoring rules, change them in both.
 *
 * Zero network, zero tokens: it scores JSON the daily scan already produced.
 */
(function (global) {
  'use strict';

  function combineWeights(weights, mode) {
    mode = mode || 'max';
    switch (mode) {
      case 'min': return Math.min.apply(null, weights);
      case 'multiply': return weights.reduce(function (a, b) { return a * b; }, 1);
      case 'average': return weights.reduce(function (a, b) { return a + b; }, 0) / weights.length;
      case 'max':
      default: return Math.max.apply(null, weights);
    }
  }

  // Two modes: /regex/flags escape hatch (with the same ergonomic defaults as
  // rank.mjs — literal space → \s+, implied leading \b), else word-stem match.
  function keyToRegExp(key) {
    var trimmed = String(key).trim();
    if (!trimmed) return null;
    var raw = trimmed.match(/^\/(.+)\/([a-z]*)$/i);
    if (raw) {
      var body = raw[1].replace(/ +/g, '\\s+');
      if (/^[\w(]/.test(body)) body = '\\b' + body;
      try {
        var flags = raw[2].indexOf('i') !== -1 ? raw[2] : raw[2] + 'i';
        return new RegExp(body, flags);
      } catch (e) {
        return null;
      }
    }
    var escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![A-Za-z0-9])' + escaped, 'i');
  }

  function matchSpan(text, key) {
    var re = keyToRegExp(key);
    if (!re) return null;
    var m = re.exec(String(text || ''));
    return m ? { start: m.index, end: m.index + m[0].length } : null;
  }

  function matchesKeyword(text, key) {
    return matchSpan(text, key) !== null;
  }

  // Maximal munch: every key's span found, resolved longest-first; a longer key
  // claims its span and suppresses shorter overlapping keys. Survivors combined.
  function scoreCategory(text, map, combine) {
    combine = combine || 'max';
    var candidates = [];
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      if (key === 'default') continue;
      var weight = map[key];
      if (typeof weight !== 'number') continue;
      var span = matchSpan(text, key);
      if (span) candidates.push({ key: key, weight: weight, start: span.start, end: span.end });
    }
    if (candidates.length === 0) {
      var fallback = typeof map.default === 'number' ? map.default : 0;
      return { score: fallback, matched: 'default' };
    }
    candidates.sort(function (a, b) {
      return (b.end - b.start) - (a.end - a.start) || b.key.length - a.key.length;
    });
    var claimed = [];
    var kept = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var overlaps = claimed.some(function (span) { return c.start < span[1] && c.end > span[0]; });
      if (!overlaps) {
        claimed.push([c.start, c.end]);
        kept.push(c);
      }
    }
    kept.sort(function (a, b) { return a.start - b.start; });
    return {
      score: combineWeights(kept.map(function (k) { return k.weight; }), combine),
      matched: kept.map(function (k) { return k.key; }).join(' + '),
    };
  }

  function normalizeWeights(weights) {
    var entries = [];
    for (var k in weights) {
      if (!Object.prototype.hasOwnProperty.call(weights, k)) continue;
      if (typeof weights[k] === 'number' && weights[k] > 0) entries.push([k, weights[k]]);
    }
    var total = entries.reduce(function (s, e) { return s + e[1]; }, 0);
    var out = {};
    if (total === 0) {
      entries.forEach(function (e) { out[e[0]] = 0; });
      return out;
    }
    entries.forEach(function (e) { out[e[0]] = e[1] / total; });
    return out;
  }

  function scoreJob(job, ranking) {
    var w = normalizeWeights(ranking.weights || {});
    var combine = ranking.combine || 'max';
    var location = scoreCategory(job.location, ranking.location || {}, combine);
    var role = scoreCategory(job.title, ranking.role || {}, combine);
    var seniority = scoreCategory(job.title, ranking.seniority || {}, combine);
    var company = scoreCategory(job.company, ranking.company || {}, combine);
    var fit =
      (w.location || 0) * location.score +
      (w.role || 0) * role.score +
      (w.seniority || 0) * seniority.score +
      (w.company || 0) * company.score;
    return Object.assign({}, job, {
      location_score: location,
      role_score: role,
      seniority_score: seniority,
      company_score: company,
      fit: fit,
    });
  }

  function rankJobs(jobs, ranking) {
    return jobs
      .map(function (j) { return scoreJob(j, ranking); })
      .sort(function (a, b) { return b.fit - a.fit || a.company.localeCompare(b.company); });
  }

  global.Rank = {
    combineWeights: combineWeights,
    keyToRegExp: keyToRegExp,
    matchSpan: matchSpan,
    matchesKeyword: matchesKeyword,
    scoreCategory: scoreCategory,
    normalizeWeights: normalizeWeights,
    scoreJob: scoreJob,
    rankJobs: rankJobs,
  };
})(typeof window !== 'undefined' ? window : globalThis);
