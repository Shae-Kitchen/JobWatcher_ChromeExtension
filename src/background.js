import { checkWatch } from './lib/checker.js';
import { collectAnchors } from './lib/dom.js';
import { detectSource, permissionOrigins, suggestName } from './lib/sources.js';
import {
  getJobs,
  getSettings,
  getWatches,
  removeJobs,
  setJobs,
  setSettings,
  setWatches,
} from './lib/storage.js';

const ALARM = 'check-all';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_HTML_BYTES = 5_000_000;

// ---------------------------------------------------------------------------
// All state mutations run one at a time so the popup, options page and the
// periodic check never overwrite each other's changes.
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Scheduling

async function ensureAlarm() {
  const { intervalMinutes } = await getSettings();
  const existing = await chrome.alarms.get(ALARM);
  if (!existing || existing.periodInMinutes !== intervalMinutes) {
    await chrome.alarms.create(ALARM, { periodInMinutes: intervalMinutes, delayInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  updateBadge();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  updateBadge();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) checkAll();
});
chrome.permissions.onAdded.addListener(async () => {
  // Retry watches that were waiting for (or failed without) site access.
  const watches = await getWatches();
  for (const w of watches) {
    if (w.enabled !== false && (!w.lastSuccess || w.lastError)) checkWatchById(w.id);
  }
});

// ---------------------------------------------------------------------------
// Fetching pages

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `Timed out fetching ${new URL(url).hostname}` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function assertSiteAccess(watch) {
  const origins = permissionOrigins(watch);
  if (origins.length && !(await chrome.permissions.contains({ origins }))) {
    throw new Error(`Needs permission to access ${new URL(watch.url).hostname}. Grant it in JobWatcher settings.`);
  }
}

let offscreenCreating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  offscreenCreating ??= chrome.offscreen
    .createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Parse fetched careers pages to find job links',
    })
    .finally(() => {
      offscreenCreating = null;
    });
  await offscreenCreating;
}

/** Fetch raw HTML and pull links out of it in the offscreen document. */
async function fetchStatic(watch) {
  await assertSiteAccess(watch);
  const res = await fetchWithTimeout(watch.url, { credentials: 'omit', headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(watch.url).hostname}`);
  const html = (await res.text()).slice(0, MAX_HTML_BYTES);
  await ensureOffscreen();
  const page = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'collect-anchors',
    html,
    selector: watch.selector || null,
  });
  return { ...page, pageUrl: res.url || watch.url };
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done(), done);
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Load the page in a minimized, unfocused window so JavaScript-rendered job
 * lists get built, then collect links once the page settles.
 */
async function fetchRendered(watch) {
  await assertSiteAccess(watch);
  let windowId = null;
  let tabId;
  try {
    const win = await chrome.windows.create({ url: watch.url, focused: false, state: 'minimized' });
    windowId = win.id;
    tabId = win.tabs[0].id;
  } catch {
    const tab = await chrome.tabs.create({ url: watch.url, active: false });
    tabId = tab.id;
  }
  try {
    await waitForTabLoad(tabId, FETCH_TIMEOUT_MS);
    let last = null;
    let lastCount = -1;
    // Poll until the number of links stops changing (SPAs load lists late).
    for (let i = 0; i < 10; i++) {
      await delay(i === 0 ? 2000 : 1500);
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: collectAnchors,
        args: [null, watch.selector || null],
      });
      last = injection?.result;
      const count = last?.anchors?.length ?? 0;
      if (count > 0 && count === lastCount) break;
      lastCount = count;
    }
    if (!last) throw new Error('Could not read the rendered page');
    return last;
  } finally {
    if (windowId !== null) chrome.windows.remove(windowId).catch(() => {});
    else chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Checking

function checkWatchById(id) {
  return serialize(async () => {
    const watches = await getWatches();
    const watch = watches.find((w) => w.id === id);
    if (!watch) throw new Error('Watch not found');
    const prev = await getJobs(id);
    const now = Date.now();
    let newJobs = [];
    try {
      const result = await checkWatch(watch, prev, { fetch: fetchWithTimeout, fetchStatic, fetchRendered, now });
      newJobs = result.newJobs;
      await setJobs(id, result.jobs);
      const active = Object.values(result.jobs).filter((j) => j.active);
      Object.assign(watch, {
        lastChecked: now,
        lastSuccess: now,
        lastError: null,
        needsBaseline: false,
        via: result.via,
        jobCount: active.length,
        totalOnPage: result.totalOnPage,
        newCount: active.filter((j) => j.isNew).length,
      });
    } catch (e) {
      Object.assign(watch, { lastChecked: now, lastError: e.message || String(e) });
    }
    await setWatches(watches.map((w) => (w.id === id ? watch : w)));
    await updateBadge();
    if (newJobs.length) await notify(watch, newJobs);
    return watch;
  });
}

let checkingAll = null;
function checkAll() {
  checkingAll ??= (async () => {
    try {
      const watches = await getWatches();
      for (const w of watches) {
        if (w.enabled === false) continue;
        await checkWatchById(w.id).catch(() => {});
      }
    } finally {
      checkingAll = null;
    }
  })();
  return checkingAll;
}

// ---------------------------------------------------------------------------
// Badge & notifications

async function updateBadge() {
  const watches = await getWatches();
  const total = watches.reduce((sum, w) => sum + (w.enabled === false ? 0 : w.newCount || 0), 0);
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await chrome.action.setBadgeText({ text: total ? String(Math.min(total, 999)) : '' });
}

async function notify(watch, newJobs) {
  const { notifications } = await getSettings();
  if (!notifications) return;
  const n = newJobs.length;
  const lines = newJobs.slice(0, 3).map((j) => j.title + (j.location ? ` · ${j.location}` : ''));
  if (n > 3) lines.push(`+${n - 3} more`);
  const id = `jw:${watch.id}:${Date.now()}`;
  await chrome.storage.session.set({ [id]: n === 1 ? newJobs[0].url : watch.url });
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: n === 1 ? `New job at ${watch.name}` : `${n} new jobs at ${watch.name}`,
    message: lines.join('\n'),
    priority: 1,
  });
}

chrome.notifications.onClicked.addListener(async (id) => {
  const data = await chrome.storage.session.get(id);
  if (data[id]) chrome.tabs.create({ url: data[id] });
  chrome.notifications.clear(id);
  chrome.storage.session.remove(id);
});
chrome.notifications.onClosed.addListener((id) => chrome.storage.session.remove(id));

// ---------------------------------------------------------------------------
// Messages from the popup and options page

const EDITABLE = ['name', 'url', 'selector', 'include', 'exclude', 'render', 'enabled', 'source'];
const AFFECTS_RESULTS = ['url', 'selector', 'include', 'exclude', 'source'];

function validUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {
    // fall through
  }
  throw new Error('Please enter a valid http(s) URL');
}

const handlers = {
  async addWatch({ watch: input }) {
    const watch = await serialize(async () => {
      const url = validUrl(input.url);
      const watches = await getWatches();
      if (watches.some((w) => w.url === url)) throw new Error('You are already tracking this page');
      const source = input.source || detectSource(url) || { type: 'html' };
      const watch = {
        id: crypto.randomUUID(),
        url,
        name: (input.name || '').trim() || suggestName(url, source),
        source,
        selector: input.selector || '',
        include: input.include || '',
        exclude: input.exclude || '',
        render: input.render || 'auto',
        enabled: true,
        createdAt: Date.now(),
        jobCount: 0,
        newCount: 0,
      };
      await setWatches([...watches, watch]);
      return watch;
    });
    // If site access is still being requested, permissions.onAdded will check it.
    const origins = permissionOrigins(watch);
    if (!origins.length || (await chrome.permissions.contains({ origins }))) checkWatchById(watch.id);
    return watch;
  },

  async updateWatch({ id, changes }) {
    const updated = await serialize(async () => {
      const watches = await getWatches();
      const watch = watches.find((w) => w.id === id);
      if (!watch) throw new Error('Watch not found');
      const before = JSON.stringify(AFFECTS_RESULTS.map((k) => watch[k]));
      for (const key of EDITABLE) {
        if (key in changes) watch[key] = changes[key];
      }
      if ('url' in changes) {
        watch.url = validUrl(changes.url);
        if (!('source' in changes)) watch.source = detectSource(watch.url) || { type: 'html' };
      }
      if (JSON.stringify(AFFECTS_RESULTS.map((k) => watch[k])) !== before) watch.needsBaseline = true;
      await setWatches(watches);
      return watch;
    });
    await updateBadge();
    return updated;
  },

  async deleteWatch({ id }) {
    await serialize(async () => {
      await setWatches((await getWatches()).filter((w) => w.id !== id));
      await removeJobs(id);
    });
    await updateBadge();
  },

  async checkNow({ id }) {
    if (id) return checkWatchById(id);
    await checkAll();
  },

  async markSeen({ id, jobId }) {
    await serialize(async () => {
      const watches = await getWatches();
      for (const w of watches) {
        if (id && w.id !== id) continue;
        const jobs = await getJobs(w.id);
        for (const job of Object.values(jobs)) {
          if (!jobId || job.id === jobId) job.isNew = false;
        }
        await setJobs(w.id, jobs);
        w.newCount = Object.values(jobs).filter((j) => j.active && j.isNew).length;
      }
      await setWatches(watches);
    });
    await updateBadge();
  },

  async setSettings({ settings }) {
    await setSettings(settings);
    await ensureAlarm();
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e.message || String(e) })
  );
  return true;
});
