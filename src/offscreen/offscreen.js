import { collectAnchors } from '../lib/dom.js';

// Service workers have no DOMParser, so the background hands fetched HTML here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'collect-anchors') return false;
  const doc = new DOMParser().parseFromString(msg.html, 'text/html');
  sendResponse(collectAnchors(doc, msg.selector));
  return false;
});
