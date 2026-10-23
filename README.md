# JobWatcher

A Chrome extension (Manifest V3) that watches company careers pages and tells you when new job postings appear.

- **One-click tracking**: open a careers page, click the JobWatcher icon, then click **Track**.
- **Background checks** every 15 minutes to once a day (configurable), with a desktop notification and a badge count for new postings.
- **Keyword filters**: only track jobs matching e.g. `engineer, product`, and exclude e.g. `senior, intern`.
- **No account or server**: everything runs and is stored locally in your browser.

## How jobs are found

| Source | How it's read |
| --- | --- |
| **Greenhouse**, **Lever**, **Ashby**, **Workday** boards | Their public JSON job-board APIs. Boards are detected from the URL, from an embed on the company's own careers page (e.g. a Greenhouse iframe), or from the page linking to the board. This is the most reliable path. |
| Any other careers page | The HTML is fetched and links that look like postings are picked out (paths like `/jobs/…`, `/careers/…`, `?gh_jid=`, or links to known applicant tracking systems). Navigation links such as "Benefits" or "View all jobs" are ignored. |
| Pages that build their job list with JavaScript | In the default **Auto** mode, if the plain HTML contains no jobs, the page is loaded briefly in a minimized window, the rendered links are read, and the window is closed. |

If auto-detection misses or over-matches on a page, set a **CSS selector** for it in settings (e.g. `.job-listing a`, or a selector for the job cards).

The first check of a page is a baseline: jobs already listed are recorded but not flagged as new. After that, any posting not seen before is flagged as new. Postings that disappear are remembered for 30 days, so one that briefly vanishes and comes back doesn't trigger a second notification. If a page that used to list jobs suddenly returns none, the previous results are kept and an error is shown instead.

## Install (developer mode)

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Pin JobWatcher from the extensions menu.

Requires Chrome 116 or newer.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save tracked pages, settings and seen jobs locally. |
| `alarms` | Schedule the periodic checks. |
| `notifications` | Alert you about new postings. |
| `activeTab`, `scripting` | Read the links on the page you're viewing when you open the popup, and on pages rendered for JavaScript-heavy sites. |
| `offscreen` | Parse fetched HTML (service workers have no DOM parser). |
| Greenhouse / Lever / Ashby / Workday API hosts | Fetch job boards from those systems. |
| Other sites (optional, requested per site) | When you track a regular careers page, Chrome asks for access to that site only, so it can be checked in the background. |

## Development

```sh
npm test          # unit tests (Node 20+, no dependencies)
npm run icons     # regenerate icons/ (requires Python + Pillow)
npm run package   # build jobwatcher.zip for the Chrome Web Store
```

### Layout

```
manifest.json
src/
  background.js        service worker: scheduling, fetching, rendering, notifications, badge
  lib/
    sources.js         ATS detection + API adapters, HTML/rendered fallback
    extract.js         job-link heuristics, keyword filters, new/removed diffing (pure)
    checker.js         runs one check for a watch
    dom.js             link collector run in the offscreen document and in tabs
    storage.js         chrome.storage helpers and popup/options → background messaging
    ui.js              small DOM helpers
  offscreen/           DOMParser host for fetched HTML
  popup/               toolbar popup: track current page, see new jobs
  options/             settings and per-page configuration
tests/                 node:test unit tests
```

All state changes go through the service worker (`chrome.runtime.sendMessage`) and are serialized there, so the popup, the options page and the background checks never overwrite each other.

## Ideas for later

- More ATS adapters (SmartRecruiters, Workable, Recruitee, Teamtailor, BambooHR).
- A "pick the job list" mode that builds a CSS selector from a click on the page.
- Email or webhook digests.
- Export or import of tracked pages.
