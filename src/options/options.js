import { detectSource, permissionOrigins, sourceLabel } from '../lib/sources.js';
import { callBackground, getSettings, getWatches } from '../lib/storage.js';
import { h, timeAgo } from '../lib/ui.js';

const $interval = document.getElementById('interval');
const $notifications = document.getElementById('notifications');
const $watches = document.getElementById('watches');
const cards = new Map(); // watch id -> {el, update(watch)}

// ---------------------------------------------------------------------------
// Settings

async function loadSettings() {
  const settings = await getSettings();
  $interval.value = String(settings.intervalMinutes);
  $notifications.checked = settings.notifications;
}
$interval.addEventListener('change', () =>
  callBackground('setSettings', { settings: { intervalMinutes: Number($interval.value) } })
);
$notifications.addEventListener('change', () =>
  callBackground('setSettings', { settings: { notifications: $notifications.checked } })
);

// ---------------------------------------------------------------------------
// Adding

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const $url = document.getElementById('add-url');
  const $name = document.getElementById('add-name');
  const $status = document.getElementById('add-status');
  const url = $url.value.trim();
  const watch = { url, name: $name.value.trim(), source: detectSource(url) || { type: 'html' } };
  // Kick off the save first, then request access while we still have the user gesture.
  const adding = callBackground('addWatch', { watch });
  const origins = permissionOrigins(watch);
  const granted = origins.length ? await chrome.permissions.request({ origins }).catch(() => false) : true;
  try {
    await adding;
    $url.value = '';
    $name.value = '';
    $status.className = granted ? 'muted' : 'warn';
    $status.textContent = granted
      ? `Tracking ${sourceLabel(watch.source).toLowerCase()}. Checking now…`
      : 'Saved, but site access was not granted. Use “Grant access” below.';
  } catch (err) {
    $status.className = 'error';
    $status.textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Watch cards

function field(label, input, hint) {
  return [h('label', {}, label), input, hint ? h('div', { class: 'hint muted' }, hint) : null];
}

function createCard(watch) {
  const name = h('input', { type: 'text', value: watch.name });
  const url = h('input', { type: 'url', value: watch.url });
  const include = h('input', { type: 'text', value: watch.include || '', placeholder: 'e.g. engineer, product' });
  const exclude = h('input', { type: 'text', value: watch.exclude || '', placeholder: 'e.g. senior, intern' });
  const selector = h('input', { type: 'text', value: watch.selector || '', placeholder: 'e.g. .job-listing a' });
  const render = h(
    'select',
    {},
    h('option', { value: 'auto' }, 'Auto: plain fetch, render if no jobs found'),
    h('option', { value: 'static' }, 'Plain fetch only'),
    h('option', { value: 'tab' }, 'Always render with JavaScript')
  );
  render.value = watch.render || 'auto';
  const enabled = h('input', { type: 'checkbox', checked: watch.enabled !== false });

  const title = h('strong');
  const sourceTag = h('span', { class: 'muted' });
  const status = h('div', { class: 'status' });
  const message = h('span', { class: 'muted' });
  const grant = h('button', { hidden: true }, 'Grant access');
  const htmlOnly = h(
    'div',
    { class: 'fields' },
    field('CSS selector', selector, 'Optional. Matches job links (or cards containing them) when auto-detection misses or over-matches.'),
    field('Page loading', render)
  );

  const card = h(
    'section',
    { class: 'card watch' },
    h('div', { class: 'watch-top' }, title, sourceTag),
    status,
    h(
      'div',
      { class: 'fields' },
      field('Name', name),
      field('URL', url),
      field('Include keywords', include, 'Only track jobs whose title, location or team contain one of these (comma separated).'),
      field('Exclude keywords', exclude),
      field('Enabled', h('label', { class: 'check' }, enabled, 'Check this page periodically'))
    ),
    htmlOnly,
    h(
      'div',
      { class: 'buttons' },
      h('button', { class: 'primary', onclick: save }, 'Save'),
      h('button', { onclick: checkNow }, 'Check now'),
      grant,
      message,
      h('span', { class: 'spacer' }),
      h('button', { class: 'danger', onclick: remove }, 'Delete')
    )
  );

  let current = watch;

  async function save() {
    const changes = {
      name: name.value.trim() || current.name,
      url: url.value.trim(),
      include: include.value,
      exclude: exclude.value,
      selector: selector.value.trim(),
      render: render.value,
      enabled: enabled.checked,
    };
    const origins = permissionOrigins({ url: changes.url, source: detectSource(changes.url) || { type: 'html' } });
    if (origins.length) await chrome.permissions.request({ origins }).catch(() => false);
    try {
      await callBackground('updateWatch', { id: current.id, changes });
      flash('Saved. Changes take effect on the next check.');
    } catch (e) {
      flash(e.message, 'error');
    }
  }

  async function checkNow() {
    flash('Checking…');
    try {
      const w = await callBackground('checkNow', { id: current.id });
      flash(w.lastError ? '' : `Found ${w.jobCount} jobs.`);
    } catch (e) {
      flash(e.message, 'error');
    }
  }

  async function remove() {
    if (!confirm(`Stop tracking ${current.name}?`)) return;
    await callBackground('deleteWatch', { id: current.id });
  }

  grant.addEventListener('click', async () => {
    const granted = await chrome.permissions.request({ origins: permissionOrigins(current) }).catch(() => false);
    if (granted) update(current);
  });

  function flash(text, cls = 'muted') {
    message.className = cls;
    message.textContent = text;
  }

  async function update(w) {
    current = w;
    title.textContent = w.name;
    sourceTag.textContent = sourceLabel(w.source) + (w.via === 'tab' ? ' (rendered)' : '');
    htmlOnly.hidden = w.source?.type !== 'html';
    if (w.lastError) {
      status.className = 'status error';
      status.textContent = `${w.lastError} (${timeAgo(w.lastChecked)})`;
    } else if (w.lastChecked) {
      status.className = 'status muted';
      status.textContent = `${w.jobCount || 0} jobs (${w.newCount || 0} new) · checked ${timeAgo(w.lastChecked)}`;
    } else {
      status.className = 'status muted';
      status.textContent = 'Not checked yet';
    }
    const origins = permissionOrigins(w);
    grant.hidden = !origins.length || (await chrome.permissions.contains({ origins }));
  }

  update(watch);
  return { el: card, update };
}

async function renderWatches() {
  const watches = await getWatches();
  const ids = new Set(watches.map((w) => w.id));
  for (const [id, card] of cards) {
    if (!ids.has(id)) {
      card.el.remove();
      cards.delete(id);
    }
  }
  // Existing cards only refresh their status so in-progress edits survive.
  for (const w of watches) {
    if (cards.has(w.id)) cards.get(w.id).update(w);
    else cards.set(w.id, createCard(w));
  }
  $watches.replaceChildren(...watches.map((w) => cards.get(w.id).el));
  if (!watches.length) $watches.append(h('p', { class: 'muted' }, 'Nothing tracked yet.'));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.watches) renderWatches();
  if (changes.settings) loadSettings();
});
chrome.permissions.onAdded.addListener(renderWatches);

loadSettings();
renderWatches();
