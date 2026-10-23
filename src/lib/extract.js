// Pure helpers for turning a list of page links into job postings, filtering
// them, and diffing against what we saw last time. No chrome.* or DOM access
// here so everything can be unit tested in Node.

const GENERIC_TEXT = new RegExp(
  '^(' +
    [
      'apply( now| here| today)?',
      'view( job| details| role| position| opening)?',
      'learn more', 'read more', 'more( info)?', 'details',
      'see (all|more)( jobs| openings| positions| roles)?',
      'view all( jobs| openings| positions| roles)?',
      'all jobs', 'jobs', 'careers?', 'open (positions|roles)',
      'search( jobs)?', 'next', 'prev(ious)?', 'back', 'home',
      'sign in', 'log ?in', 'register', 'privacy( policy)?', 'terms',
      'cookies?( policy| settings)?', 'here', 'click here', 'share', 'save',
      '[›»→<>]+',
    ].join('|') +
    ')$',
  'i'
);

const JOB_URL_PATTERNS = [
  /\/(jobs?|careers?|positions?|openings?|vacanc(y|ies)|opportunit(y|ies)|roles?|postings?|requisitions?|job-?details?|job-?posting)\/[^/?#]+/i,
  /[?&](gh_jid|jid|job_?id|jobid|req_?id|posting_?id)=/i,
  /lever\.co\/[^/]+\/[0-9a-f-]{8,}/i,
  /greenhouse\.io\/[^/]+\/jobs\/\d+/i,
  /ashbyhq\.com\/[^/]+\/[0-9a-f-]{8,}/i,
  /myworkdayjobs\.com\/.*\/job\//i,
  /smartrecruiters\.com\/[^/]+\/\d+/i,
  /workable\.com\/.*\/j\/[A-Z0-9]+/i,
  /jobvite\.com\/.*\/job\//i,
  /icims\.com\/jobs\/\d+/i,
  /bamboohr\.com\/(careers|jobs)\/\d+/i,
  /recruitee\.com\/o\//i,
];

// Careers sub-pages that are not individual postings.
const EXCLUDED_PATH =
  /\/(careers?|jobs?)\/(benefits|culture|teams?|life|students?|university|graduates?|interns?(hips?)?|faq|about|values|locations?|search|departments?|categories|alerts?|login|sign-?in|privacy|perks|diversity|how-we-hire|hiring-process)(\/|$)/i;

const BLOCKED_HOSTS = /(^|\.)(facebook|twitter|x|instagram|youtube|tiktok|pinterest|glassdoor)\.com$/i;

const TRACKING_PARAM = /^(utm_.*|gh_src|lever-source.*|lever-origin|source|ref|referrer|src|trk.*|fbclid|gclid)$/i;

export function cleanText(text, max = 200) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

export function normalizeUrl(href, base) {
  if (!href) return null;
  let u;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Keep hash-router fragments (#/jobs/123), drop plain anchors.
  if (!/^#!?\//.test(u.hash)) u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  }
  return u.href;
}

export function isGenericText(text) {
  return GENERIC_TEXT.test(cleanText(text));
}

export function looksLikeJobUrl(url, pageUrl) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (BLOCKED_HOSTS.test(u.hostname)) return false;
  if (/(^|\.)linkedin\.com$/i.test(u.hostname) && !/^\/jobs\/view\//.test(u.pathname)) return false;
  if (EXCLUDED_PATH.test(u.pathname) && !u.search) return false;
  if (pageUrl) {
    try {
      const p = new URL(pageUrl);
      // Links to a parent of the listing page (e.g. /careers from /careers/jobs).
      const linkPath = u.pathname.replace(/\/$/, '');
      if (p.origin === u.origin && !u.search && !u.hash && p.pathname.replace(/\/$/, '').startsWith(linkPath)) {
        return false;
      }
    } catch {
      // ignore malformed page URL
    }
  }
  return JOB_URL_PATTERNS.some((re) => re.test(u.href));
}

/**
 * Turn raw anchors ({href, text}) collected from a page into job postings.
 * With a CSS selector the user has told us exactly which links are jobs, so the
 * URL heuristic is skipped.
 */
export function extractJobs({ anchors, base, pageUrl, selector }) {
  const pageNorm = normalizeUrl(pageUrl);
  let baseUrl = pageUrl;
  if (base) {
    try {
      baseUrl = new URL(base, pageUrl).href;
    } catch {
      // keep pageUrl
    }
  }
  const jobs = new Map();
  for (const anchor of anchors || []) {
    const url = normalizeUrl(anchor.href, baseUrl);
    if (!url || url === pageNorm) continue;
    const title = cleanText(anchor.text);
    if (title.length < 2 || isGenericText(title)) continue;
    if (!selector && !looksLikeJobUrl(url, pageNorm)) continue;
    if (!jobs.has(url)) jobs.set(url, { id: url, title, url });
  }
  return [...jobs.values()];
}

export function parseKeywords(value) {
  return String(value ?? '')
    .split(/[,\n]/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

export function matchesFilters(job, include = [], exclude = []) {
  const hay = `${job.title} ${job.location || ''} ${job.department || ''}`.toLowerCase();
  if (include.length && !include.some((k) => hay.includes(k))) return false;
  return !exclude.some((k) => hay.includes(k));
}

const FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Merge the current listing into the stored job map.
 * - Jobs never seen before are flagged isNew (unless this is a baseline run).
 * - Jobs that disappear are kept as inactive for 30 days so a temporarily
 *   missing posting does not re-trigger a notification when it comes back.
 */
export function diffJobs(prev, current, now, baseline) {
  const jobs = {};
  const newJobs = [];
  for (const job of current) {
    const old = prev[job.id];
    if (old) {
      jobs[job.id] = { ...old, ...job, firstSeen: old.firstSeen, isNew: old.isNew, active: true };
      delete jobs[job.id].removedAt;
    } else {
      const entry = { ...job, firstSeen: now, isNew: !baseline, active: true };
      jobs[job.id] = entry;
      if (!baseline) newJobs.push(entry);
    }
  }
  let removed = 0;
  for (const [id, old] of Object.entries(prev)) {
    if (jobs[id]) continue;
    const removedAt = old.active === false ? old.removedAt : now;
    if (now - removedAt > FORGET_AFTER_MS) continue;
    if (old.active !== false) removed++;
    jobs[id] = { ...old, active: false, isNew: false, removedAt };
  }
  return { jobs, newJobs, removed };
}
