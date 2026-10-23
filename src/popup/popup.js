import { collectAnchors } from '../lib/dom.js';
import { extractJobs } from '../lib/extract.js';
import { detectSourceFromPage, permissionOrigins, sourceLabel, suggestName } from '../lib/sources.js';
import { callBackground, getJobs, getWatches } from '../lib/storage.js';
import { h, hostOf, timeAgo } from '../lib/ui.js';

const $current = document.getElementById('current');
const $watches = document.getElementById('watches');
const $summary = document.getElementById('summary');
const expanded = new Set();
let firstRender = true;
let page = null; // analysis of the active tab
const busy = new Set(); // watch ids being checked
let trackNotice = null; // shown after tracking if site access was declined

document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('mark-all').addEventListener('click', () => callBackground('markSeen'));
document.getElementById('check-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add('spin');
  try {
    await callBackground('checkNow');
  } finally {
    btn.disabled = false;
    btn.classList.remove('spin');
  }
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') render();
});

// ---------------------------------------------------------------------------
// Current tab

async function analyzeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) return { trackable: false };
  let result = null;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectAnchors,
      args: [null, null],
    });
    result = injection?.result;
  } catch {
    // Some pages (e.g. the Chrome Web Store) can't be scripted; we can still track the URL.
  }
  const url = tab.url;
  const anchors = result?.anchors || [];
  const source = detectSourceFromPage({ url, frames: result?.frames || [], anchors }) || { type: 'html' };
  const jobLinks = source.type === 'html' ? extractJobs({ anchors, base: result?.base, pageUrl: url }).length : null;
  return { trackable: true, url, title: tab.title, source, jobLinks };
}

function renderCurrent(watches) {
  $current.replaceChildren();
  if (!page) {
    $current.append(h('div', { class: 'muted' }, 'Looking at this page…'));
    return;
  }
  if (!page.trackable) {
    $current.append(
      h('div', { class: 'label' }, 'This page'),
      h('div', { class: 'muted' }, 'Open a company careers page, then click the JobWatcher icon to track it.')
    );
    return;
  }
  const existing = watches.find((w) => w.url === page.url);
  $current.append(h('div', { class: 'label' }, 'This page'));
  if (existing) {
    $current.append(h('div', {}, '✓ Tracking as ', h('strong', {}, existing.name)));
    if (trackNotice) $current.append(h('div', { class: 'warn' }, trackNotice));
    return;
  }

  const detail =
    page.source.type !== 'html'
      ? `Detected ${sourceLabel(page.source)}: jobs will be read from its API.`
      : page.jobLinks
        ? `Found ${page.jobLinks} job link${page.jobLinks === 1 ? '' : 's'} on this page.`
        : 'No job links detected yet. You can still track it and set a CSS selector in settings.';
  const nameInput = h('input', { type: 'text', value: suggestName(page.url, page.source), 'aria-label': 'Name' });
  const status = h('div', { class: 'muted' });
  const button = h('button', { class: 'primary' }, 'Track');
  button.addEventListener('click', () => track(nameInput.value, button, status));
  $current.append(
    h('div', { class: page.jobLinks === 0 ? 'warn' : 'muted' }, detail),
    h('div', { class: 'row' }, nameInput, button),
    status
  );
}

async function track(name, button, status) {
  button.disabled = true;
  status.className = 'muted';
  status.textContent = '';
  const watch = { url: page.url, name, source: page.source };
  const origins = permissionOrigins(watch);
  // Start saving, then ask for site access straight away: permissions.request
  // must run while the click still counts as a user gesture.
  const adding = callBackground('addWatch', { watch });
  let granted = true;
  if (origins.length) granted = await chrome.permissions.request({ origins }).catch(() => false);
  try {
    const added = await adding;
    expanded.add(added.id);
    if (!granted) {
      trackNotice = 'JobWatcher needs access to this site to check it. Grant it in settings.';
      render();
    }
  } catch (e) {
    status.className = 'error';
    status.textContent = e.message;
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Watch list

function sortJobs(jobs) {
  return Object.values(jobs)
    .filter((j) => j.active !== false)
    .sort((a, b) => (b.isNew - a.isNew) || (b.firstSeen - a.firstSeen) || a.title.localeCompare(b.title));
}

function statusLine(w) {
  if (busy.has(w.id)) return h('div', { class: 'meta muted' }, h('span', { class: 'spin' }, '↻'), ' Checking…');
  if (w.lastError) return h('div', { class: 'meta error' }, w.lastError);
  if (!w.lastChecked) return h('div', { class: 'meta muted' }, 'Waiting for first check…');
  const parts = [sourceLabel(w.source), `${w.jobCount || 0} jobs`, `checked ${timeAgo(w.lastChecked)}`];
  if (w.enabled === false) parts.unshift('Paused');
  const line = h('div', { class: 'meta muted' }, parts.join(' · '));
  if (w.lastSuccess && !w.jobCount && !w.totalOnPage && w.source?.type === 'html') {
    return [line, h('div', { class: 'meta warn' }, 'No job links found. Try a CSS selector in settings.')];
  }
  return line;
}

async function renderWatch(w) {
  const open = expanded.has(w.id);
  const head = h(
    'div',
    { class: 'watch-head', onclick: () => toggle(w.id) },
    h('span', { class: 'chev' }, open ? '▾' : '▸'),
    h('span', { class: 'name', title: w.url }, w.name),
    w.newCount ? h('span', { class: 'pill', title: 'New jobs' }, `${w.newCount} new`) : null,
    h('button', {
      class: 'icon',
      title: 'Check now',
      onclick: (e) => {
        e.stopPropagation();
        checkOne(w.id);
      },
    }, '↻')
  );
  const el = h('div', { class: `watch${w.enabled === false ? ' disabled' : ''}` }, head, statusLine(w));
  if (!open) return el;

  const jobs = sortJobs(await getJobs(w.id));
  const shown = jobs.slice(0, 50);
  if (shown.length) {
    el.append(
      h(
        'ul',
        { class: 'jobs' },
        shown.map((j) =>
          h(
            'li',
            { class: j.isNew ? 'new' : '' },
            h('span', { class: `dot${j.isNew ? '' : ' seen'}` }),
            h(
              'span',
              { class: 'title' },
              h('a', {
                href: j.url,
                target: '_blank',
                rel: 'noopener',
                onclick: () => j.isNew && callBackground('markSeen', { id: w.id, jobId: j.id }),
              }, j.title),
              j.location ? h('span', { class: 'loc' }, ` · ${j.location}`) : null
            )
          )
        )
      )
    );
  }
  el.append(
    h(
      'div',
      { class: 'watch-tools' },
      jobs.length > shown.length ? h('span', { class: 'muted' }, `+${jobs.length - shown.length} more`) : null,
      h('a', { href: w.url, target: '_blank', rel: 'noopener' }, `Open ${hostOf(w.url)}`),
      w.newCount ? h('button', { class: 'link', onclick: () => callBackground('markSeen', { id: w.id }) }, 'Mark seen') : null
    )
  );
  return el;
}

function toggle(id) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  render();
}

async function checkOne(id) {
  busy.add(id);
  render();
  try {
    await callBackground('checkNow', { id });
  } finally {
    busy.delete(id);
    render();
  }
}

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  const watches = await getWatches();
  if (firstRender) {
    // Open the watches that have something new on first view.
    for (const w of watches) if (w.newCount) expanded.add(w.id);
    firstRender = false;
  }
  const items = await Promise.all(watches.map(renderWatch));
  if (token !== renderToken) return; // a newer render started meanwhile
  renderCurrent(watches);
  $watches.replaceChildren(
    ...(items.length
      ? items
      : [h('div', { class: 'empty muted' }, 'No pages tracked yet. Open a careers page and click Track, or add one in settings.')])
  );
  const totalNew = watches.reduce((n, w) => n + (w.newCount || 0), 0);
  $summary.textContent = watches.length
    ? `${watches.length} page${watches.length === 1 ? '' : 's'} · ${totalNew} new`
    : '';
  document.getElementById('mark-all').hidden = !totalNew;
}

render();
analyzeTab()
  .then((result) => (page = result))
  .catch(() => (page = { trackable: false }))
  .finally(render);
