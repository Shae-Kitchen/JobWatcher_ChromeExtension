// Runs in a DOM context: the offscreen document (on HTML fetched in the
// background) and live tabs via chrome.scripting.executeScript. It must stay
// self-contained (no imports or outer variables) because executeScript
// serializes the function source.
export function collectAnchors(root, selector) {
  const doc = root || document;
  const HEADING = 'h1,h2,h3,h4,h5,h6,[class*="title" i],[data-testid*="title" i]';
  const GENERIC = /^(apply|apply now|view|view job|view details|details|learn more|read more|more|see more|›|»|→)$/i;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const titleOf = (a) => {
    const heading = a.querySelector(HEADING);
    let text =
      clean(heading ? heading.textContent : a.textContent) ||
      clean(a.getAttribute('aria-label')) ||
      clean(a.getAttribute('title'));
    if (!text || GENERIC.test(text)) {
      // "Apply" style link: borrow the heading of the surrounding job card.
      const card = a.closest('li,tr,article,[class*="job" i],[class*="posting" i],[class*="position" i],[class*="opening" i]');
      const cardHeading = card && card.querySelector(HEADING);
      if (cardHeading) text = clean(cardHeading.textContent);
    }
    return text;
  };

  let elements;
  try {
    elements = doc.querySelectorAll(selector || 'a[href]');
  } catch (e) {
    return { error: `Invalid CSS selector: ${selector}`, anchors: [], frames: [] };
  }

  const anchors = [];
  for (const el of elements) {
    const a = el.matches('a[href]') ? el : el.querySelector('a[href]') || el.closest('a[href]');
    if (!a) continue;
    anchors.push({ href: a.getAttribute('href'), text: titleOf(a) });
    if (anchors.length >= 3000) break;
  }
  const frames = Array.from(doc.querySelectorAll('iframe[src],script[src]'), (e) => e.getAttribute('src')).slice(0, 300);
  const base = doc.querySelector('base[href]');
  return {
    anchors,
    frames,
    base: base ? base.getAttribute('href') : null,
    title: clean(doc.title),
    pageUrl: doc.location ? doc.location.href : null,
  };
}
