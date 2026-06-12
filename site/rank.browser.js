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

  // ── Group-model scoring (mirrors rank.mjs 1:1) ────────────────────────────
  // The board's schema, shared with the Node scanner. See rank.mjs for the full
  // doc. Membership matching (any keyword hits); the rating lives on the filter;
  // cross-filter conflicts resolve via the group's `combine` (min/max/avg).
  var DEFAULT_GROUP_WEIGHT = 0.5;

  function combineGroup(weights, mode) {
    mode = mode || 'min';
    if (mode === 'max') return Math.max.apply(null, weights);
    if (mode === 'avg' || mode === 'average') return weights.reduce(function (a, b) { return a + b; }, 0) / weights.length;
    return Math.min.apply(null, weights); // 'min' — worst match wins (0/exclude wins)
  }

  // A filter's display label. `name` is OPTIONAL — when absent, the first
  // non-empty keyword stands in (so portals.yml / board filters can omit it).
  function filterLabel(f) {
    if (f && f.name && String(f.name).trim()) return String(f.name).trim();
    var kws = (f && f.keywords) || [];
    for (var i = 0; i < kws.length; i++) {
      if (kws[i] && String(kws[i]).trim()) return String(kws[i]).trim();
    }
    return '';
  }

  // `field` may be a single id or an ARRAY of ids (joined with a space → one
  // combined string the keyword matches against). Mirrors rank.mjs (parity).
  function fieldText(job, field) {
    if (Array.isArray(field)) return field.map(function (f) { return fieldText(job, f); }).join(' ');
    if (field === 'company') return job.company || '';
    if (field === 'location') return job.location || '';
    if (field === 'department') return job.department || '';
    // `workMode` is already the tri-state token 'remote'|'hybrid'|'onsite';
    // unknown → '' so the job falls through to the group's catch-all. Mirrors
    // rank.mjs fieldText (parity).
    if (field === 'workmode') return job.workMode || '';
    if (field === 'any') return (job.title || '') + ' ' + (job.company || '') + ' ' + (job.location || '') + ' ' + (job.department || '');
    return job.title || '';
  }

  function filterRegexes(f) {
    if (!f._res) f._res = (f.keywords || []).map(keyToRegExp).filter(Boolean);
    return f._res;
  }

  function filterMatches(text, f) {
    var res = filterRegexes(f);
    for (var i = 0; i < res.length; i++) {
      var re = res[i]; if (re.global) re.lastIndex = 0;
      if (re.test(text)) return true;
    }
    return false;
  }

  function matchGroup(job, group) {
    var text = fieldText(job, group.field);
    var matched = [], anyKeyword = false, elseFilter = null;
    var filters = group.filters || [];
    for (var i = 0; i < filters.length; i++) {
      var f = filters[i];
      if (f.else) { elseFilter = f; continue; }
      if (filterMatches(text, f)) { matched.push(f); anyKeyword = true; }
    }
    if (elseFilter && !anyKeyword) matched.push(elseFilter);
    return matched;
  }

  function scoreGroup(job, group) {
    var vals = [];
    matchGroup(job, group).forEach(function (f) { if (typeof f.weight === 'number') vals.push(f.weight); });
    if (!vals.length) return DEFAULT_GROUP_WEIGHT;
    return combineGroup(vals, group.combine || 'min');
  }

  function isExcluded(job, groups) {
    return groups.some(function (g) { return matchGroup(job, g).some(function (f) { return f.weight === 0; }); });
  }

  function fitGroups(job, groups) {
    var total = 0, sum = 0;
    groups.forEach(function (g) { var w = g.weight || 0; total += w; sum += w * scoreGroup(job, g); });
    return total ? sum / total : DEFAULT_GROUP_WEIGHT;
  }

  function scoreJobGroups(job, groups) {
    var breakdown = groups.map(function (g) {
      var matched = matchGroup(job, g);
      return {
        name: g.name, field: g.field, score: scoreGroup(job, g),
        matched: matched.filter(function (f) { return !f.else; }).map(filterLabel).filter(Boolean),
      };
    });
    return Object.assign({}, job, { group_scores: breakdown, fit: fitGroups(job, groups), excluded: isExcluded(job, groups) });
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
    // Group-model core (shared with rank.mjs)
    DEFAULT_GROUP_WEIGHT: DEFAULT_GROUP_WEIGHT,
    combineGroup: combineGroup,
    filterLabel: filterLabel,
    fieldText: fieldText,
    filterMatches: filterMatches,
    matchGroup: matchGroup,
    scoreGroup: scoreGroup,
    isExcluded: isExcluded,
    fitGroups: fitGroups,
    scoreJobGroups: scoreJobGroups,
  };
})(typeof window !== 'undefined' ? window : globalThis);
