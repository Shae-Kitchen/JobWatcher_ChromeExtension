// Job sources: detection of applicant tracking systems (ATS) with public JSON
// APIs, plus fetching jobs for a watch. Browser-specific work (parsing HTML,
// rendering pages in a tab) is injected via `deps` so this stays testable.

import { cleanText, extractJobs } from './extract.js';

const WORKDAY_HOST = /^([\w-]+)\.(wd\d+)\.myworkdayjobs\.com$/i;
const LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/;

function firstSegment(u) {
  return u.pathname.split('/').filter(Boolean)[0] || '';
}

/** Detect an ATS job board from a URL. Returns a source object or null. */
export function detectSource(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();

  const gh = host.match(/^(?:boards|job-boards)(\.eu)?\.greenhouse\.io$/);
  if (gh) {
    let board = firstSegment(u);
    if (board === 'embed') board = u.searchParams.get('for') || '';
    if (board && board !== 'embed') return { type: 'greenhouse', board, region: gh[1] ? 'eu' : '' };
  }
  const ghApi = host.match(/^boards-api(\.eu)?\.greenhouse\.io$/);
  if (ghApi) {
    const m = u.pathname.match(/\/v1\/boards\/([^/]+)/);
    if (m) return { type: 'greenhouse', board: m[1], region: ghApi[1] ? 'eu' : '' };
  }

  const lever = host.match(/^jobs(\.eu)?\.lever\.co$/);
  if (lever && firstSegment(u)) {
    return { type: 'lever', board: firstSegment(u), region: lever[1] ? 'eu' : '' };
  }

  if (host === 'jobs.ashbyhq.com' && firstSegment(u)) {
    return { type: 'ashby', board: decodeURIComponent(firstSegment(u)) };
  }

  const wd = host.match(WORKDAY_HOST);
  if (wd) {
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments[0] === 'wday' && segments[1] === 'cxs') {
      return { type: 'workday', origin: u.origin, tenant: segments[2], site: segments[3] };
    }
    const site = LOCALE.test(segments[0] || '') ? segments[1] : segments[0];
    if (site) return { type: 'workday', origin: u.origin, tenant: wd[1], site };
  }
  return null;
}

/**
 * Detect an ATS for a whole page: the page URL itself, then embedded
 * iframes/scripts (e.g. a Greenhouse embed on acme.com/careers), then the
 * most common ATS among the page's links.
 */
export function detectSourceFromPage({ url, frames = [], anchors = [] }) {
  const direct = detectSource(url);
  if (direct) return direct;
  const resolve = (href) => {
    try {
      return new URL(href, url).href;
    } catch {
      return null;
    }
  };
  for (const src of frames) {
    const s = resolve(src);
    if (!s) continue;
    // Greenhouse embed script: boards.greenhouse.io/embed/job_board/js?for=acme
    const found = detectSource(s);
    if (found && found.board !== 'js') return found;
  }
  const counts = new Map();
  for (const a of anchors) {
    const href = resolve(a.href);
    const found = href && detectSource(href);
    if (!found) continue;
    const key = JSON.stringify(found);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) [best, bestCount] = [key, count];
  }
  return best ? JSON.parse(best) : null;
}

export function sourceLabel(source) {
  switch (source?.type) {
    case 'greenhouse':
      return `Greenhouse · ${source.board}`;
    case 'lever':
      return `Lever · ${source.board}`;
    case 'ashby':
      return `Ashby · ${source.board}`;
    case 'workday':
      return `Workday · ${source.tenant}/${source.site}`;
    default:
      return 'Web page';
  }
}

/** Host permissions a watch needs beyond the ones in the manifest. */
export function permissionOrigins(watch) {
  if (watch.source?.type && watch.source.type !== 'html') return [];
  try {
    const u = new URL(watch.url);
    return [`${u.protocol}//${u.hostname}/*`];
  } catch {
    return [];
  }
}

export function suggestName(url, source) {
  if (source?.board) return titleCase(source.board);
  if (source?.tenant) return titleCase(source.tenant);
  try {
    const labels = new URL(url).hostname.split('.').filter((l) => !/^(www|careers?|jobs?|apply)$/i.test(l));
    return titleCase(labels.length > 1 ? labels[labels.length - 2] : labels[0] || url);
  } catch {
    return url;
  }
}

function titleCase(s) {
  return String(s)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function getJson(fetchFn, url, init = {}) {
  const res = await fetchFn(url, { credentials: 'omit', ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return res.json();
}

const MAX_WORKDAY_JOBS = 1000;

async function fetchWorkday(source, fetchFn) {
  const endpoint = `${source.origin}/wday/cxs/${source.tenant}/${source.site}/jobs`;
  const jobs = [];
  let total = Infinity;
  for (let offset = 0; offset < total && offset < MAX_WORKDAY_JOBS; offset += 20) {
    const data = await getJson(fetchFn, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
    });
    if (offset === 0) total = Number(data.total) || 0;
    const page = data.jobPostings || [];
    for (const p of page) {
      if (!p.externalPath) continue;
      jobs.push({
        id: p.externalPath,
        title: cleanText(p.title),
        url: `${source.origin}/${source.site}${p.externalPath}`,
        location: cleanText(p.locationsText),
      });
    }
    if (page.length === 0) break;
  }
  return jobs;
}

/**
 * Fetch the current listing for a watch.
 * deps.fetch            – fetch implementation
 * deps.fetchStatic(w)   – {anchors, base, pageUrl} from the raw HTML
 * deps.fetchRendered(w) – same, from the page rendered in a browser tab
 * Returns {jobs, via}.
 */
export async function fetchJobs(watch, deps) {
  const source = watch.source || { type: 'html' };
  const f = deps.fetch;
  switch (source.type) {
    case 'greenhouse': {
      const host = source.region === 'eu' ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io';
      const data = await getJson(f, `https://${host}/v1/boards/${encodeURIComponent(source.board)}/jobs`);
      const jobs = (data.jobs || []).map((j) => ({
        id: String(j.id),
        title: cleanText(j.title),
        url: j.absolute_url,
        location: cleanText(j.location?.name),
      }));
      return { jobs, via: 'api' };
    }
    case 'lever': {
      const host = source.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
      const data = await getJson(f, `https://${host}/v0/postings/${encodeURIComponent(source.board)}?mode=json`);
      const jobs = (Array.isArray(data) ? data : []).map((j) => ({
        id: j.id,
        title: cleanText(j.text),
        url: j.hostedUrl,
        location: cleanText(j.categories?.location || j.categories?.allLocations?.join(', ')),
        department: cleanText(j.categories?.team || j.categories?.department),
      }));
      return { jobs, via: 'api' };
    }
    case 'ashby': {
      const data = await getJson(
        f,
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(source.board)}?includeCompensation=false`
      );
      const jobs = (data.jobs || [])
        .filter((j) => j.isListed !== false)
        .map((j) => ({
          id: j.id,
          title: cleanText(j.title),
          url: j.jobUrl,
          location: cleanText(j.location),
          department: cleanText(j.department || j.team),
        }));
      return { jobs, via: 'api' };
    }
    case 'workday':
      return { jobs: await fetchWorkday(source, f), via: 'api' };
    default: {
      const render = watch.render || 'auto';
      const run = async (fetcher) => {
        const page = await fetcher(watch);
        if (page.error) throw new Error(page.error);
        return extractJobs({ ...page, pageUrl: page.pageUrl || watch.url, selector: watch.selector });
      };
      if (render !== 'tab') {
        let jobs = [];
        let staticError = null;
        try {
          jobs = await run(deps.fetchStatic);
        } catch (e) {
          if (render === 'static') throw e;
          staticError = e;
        }
        if (jobs.length || render === 'static') return { jobs, via: 'static' };
        // Nothing in the raw HTML: most likely the list is rendered by JavaScript.
        try {
          return { jobs: await run(deps.fetchRendered), via: 'tab' };
        } catch (e) {
          throw staticError || e;
        }
      }
      return { jobs: await run(deps.fetchRendered), via: 'tab' };
    }
  }
}
