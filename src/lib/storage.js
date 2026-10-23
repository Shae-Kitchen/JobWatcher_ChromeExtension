// chrome.storage.local layout:
//   settings      – {intervalMinutes, notifications}
//   watches       – array of watch objects
//   jobs:<id>     – {[jobId]: job} for one watch

export const DEFAULT_SETTINGS = { intervalMinutes: 60, notifications: true };

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function setSettings(settings) {
  await chrome.storage.local.set({ settings: { ...(await getSettings()), ...settings } });
}

export async function getWatches() {
  const { watches } = await chrome.storage.local.get('watches');
  return watches || [];
}

export async function setWatches(watches) {
  await chrome.storage.local.set({ watches });
}

export const jobsKey = (watchId) => `jobs:${watchId}`;

export async function getJobs(watchId) {
  const key = jobsKey(watchId);
  const data = await chrome.storage.local.get(key);
  return data[key] || {};
}

export async function setJobs(watchId, jobs) {
  await chrome.storage.local.set({ [jobsKey(watchId)]: jobs });
}

export async function removeJobs(watchId) {
  await chrome.storage.local.remove(jobsKey(watchId));
}

/** Send a message to the service worker; throws on {ok:false}. */
export async function callBackground(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}
