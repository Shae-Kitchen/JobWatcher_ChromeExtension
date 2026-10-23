import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWatch } from '../src/lib/checker.js';
import { detectSource, detectSourceFromPage, fetchJobs, permissionOrigins, suggestName } from '../src/lib/sources.js';

test('detectSource recognises ATS boards', () => {
  assert.deepEqual(detectSource('https://boards.greenhouse.io/acme'), { type: 'greenhouse', board: 'acme', region: '' });
  assert.deepEqual(detectSource('https://job-boards.eu.greenhouse.io/acme/jobs/1'), {
    type: 'greenhouse',
    board: 'acme',
    region: 'eu',
  });
  assert.deepEqual(detectSource('https://boards.greenhouse.io/embed/job_board?for=acme'), {
    type: 'greenhouse',
    board: 'acme',
    region: '',
  });
  assert.deepEqual(detectSource('https://jobs.lever.co/acme'), { type: 'lever', board: 'acme', region: '' });
  assert.deepEqual(detectSource('https://jobs.ashbyhq.com/Acme%20Inc'), { type: 'ashby', board: 'Acme Inc' });
  assert.deepEqual(detectSource('https://acme.wd5.myworkdayjobs.com/en-US/External'), {
    type: 'workday',
    origin: 'https://acme.wd5.myworkdayjobs.com',
    tenant: 'acme',
    site: 'External',
  });
  assert.equal(detectSource('https://acme.com/careers'), null);
  assert.equal(detectSource('not a url'), null);
});

test('detectSourceFromPage finds embedded boards and linked boards', () => {
  assert.equal(
    detectSourceFromPage({
      url: 'https://acme.com/careers',
      frames: ['https://boards.greenhouse.io/embed/job_board/js?for=acme'],
    }).board,
    'acme'
  );
  const linked = detectSourceFromPage({
    url: 'https://acme.com/careers',
    anchors: [
      { href: 'https://jobs.lever.co/acme/1111-2222' },
      { href: 'https://jobs.lever.co/acme/3333-4444' },
      { href: 'https://boards.greenhouse.io/partner' },
    ],
  });
  assert.deepEqual(linked, { type: 'lever', board: 'acme', region: '' });
  assert.equal(detectSourceFromPage({ url: 'https://acme.com/careers' }), null);
});

test('permissionOrigins only needed for plain web pages', () => {
  assert.deepEqual(permissionOrigins({ url: 'https://acme.com/careers', source: { type: 'html' } }), [
    'https://acme.com/*',
  ]);
  assert.deepEqual(permissionOrigins({ url: 'https://jobs.lever.co/acme', source: { type: 'lever' } }), []);
});

test('suggestName', () => {
  assert.equal(suggestName('https://careers.acme-corp.com/jobs'), 'Acme Corp');
  assert.equal(suggestName('https://jobs.lever.co/acme', { type: 'lever', board: 'acme' }), 'Acme');
});

function jsonFetch(routes) {
  return async (url, init) => {
    const handler = routes[url];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => handler(init) };
  };
}

test('fetchJobs: Greenhouse', async () => {
  const fetch = jsonFetch({
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs': () => ({
      jobs: [{ id: 7, title: 'Engineer', absolute_url: 'https://x/7', location: { name: 'NYC' } }],
    }),
  });
  const { jobs } = await fetchJobs({ source: { type: 'greenhouse', board: 'acme' } }, { fetch });
  assert.deepEqual(jobs, [{ id: '7', title: 'Engineer', url: 'https://x/7', location: 'NYC' }]);
});

test('fetchJobs: Lever and Ashby', async () => {
  const fetch = jsonFetch({
    'https://api.lever.co/v0/postings/acme?mode=json': () => [
      { id: 'l1', text: 'Designer', hostedUrl: 'https://l/1', categories: { location: 'Remote', team: 'Design' } },
    ],
    'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=false': () => ({
      jobs: [
        { id: 'a1', title: 'PM', jobUrl: 'https://a/1', location: 'SF', isListed: true },
        { id: 'a2', title: 'Hidden', jobUrl: 'https://a/2', isListed: false },
      ],
    }),
  });
  const lever = await fetchJobs({ source: { type: 'lever', board: 'acme' } }, { fetch });
  assert.equal(lever.jobs[0].department, 'Design');
  const ashby = await fetchJobs({ source: { type: 'ashby', board: 'acme' } }, { fetch });
  assert.deepEqual(ashby.jobs.map((j) => j.id), ['a1']);
});

test('fetchJobs: Workday paginates', async () => {
  const all = Array.from({ length: 45 }, (_, i) => ({ title: `Job ${i}`, externalPath: `/job/x/${i}`, locationsText: 'NYC' }));
  const fetch = jsonFetch({
    'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Ext/jobs': (init) => {
      const { offset, limit } = JSON.parse(init.body);
      return { total: all.length, jobPostings: all.slice(offset, offset + limit) };
    },
  });
  const { jobs } = await fetchJobs(
    { source: { type: 'workday', origin: 'https://acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'Ext' } },
    { fetch }
  );
  assert.equal(jobs.length, 45);
  assert.equal(jobs[3].url, 'https://acme.wd1.myworkdayjobs.com/Ext/job/x/3');
});

test('fetchJobs: HTML auto mode falls back to rendering when the static page is empty', async () => {
  const watch = { url: 'https://acme.com/careers', source: { type: 'html' } };
  const deps = {
    fetchStatic: async () => ({ anchors: [{ href: '/about', text: 'About' }] }),
    fetchRendered: async () => ({ anchors: [{ href: '/careers/eng-1', text: 'Engineer' }] }),
  };
  const res = await fetchJobs(watch, deps);
  assert.equal(res.via, 'tab');
  assert.equal(res.jobs[0].url, 'https://acme.com/careers/eng-1');

  const staticOnly = await fetchJobs({ ...watch, render: 'static' }, deps);
  assert.equal(staticOnly.jobs.length, 0);
  assert.equal(staticOnly.via, 'static');
});

test('fetchJobs: surfaces an invalid selector', async () => {
  const deps = { fetchStatic: async () => ({ error: 'Invalid CSS selector: ][', anchors: [] }) };
  await assert.rejects(
    fetchJobs({ url: 'https://acme.com', source: { type: 'html' }, render: 'static' }, deps),
    /Invalid CSS selector/
  );
});

test('checkWatch: baseline first, then reports new jobs that pass filters', async () => {
  let listing = [{ href: '/careers/eng-1', text: 'Engineer' }];
  const deps = { fetchStatic: async () => ({ anchors: listing }), now: 100 };
  const watch = { url: 'https://acme.com/careers', source: { type: 'html' }, render: 'static', exclude: 'intern' };

  const first = await checkWatch(watch, {}, deps);
  assert.equal(first.baseline, true);
  assert.equal(first.newJobs.length, 0);

  listing = [...listing, { href: '/careers/eng-2', text: 'Engineer II' }, { href: '/careers/int-1', text: 'Intern' }];
  const second = await checkWatch({ ...watch, lastSuccess: 100 }, first.jobs, { ...deps, now: 200 });
  assert.deepEqual(second.newJobs.map((j) => j.title), ['Engineer II']);
});

test('checkWatch keeps previous results when a page suddenly comes back empty', async () => {
  const prev = { a: { id: 'a', title: 'A', url: 'u', active: true } };
  const deps = { fetchStatic: async () => ({ anchors: [] }) };
  await assert.rejects(
    checkWatch({ url: 'https://acme.com', source: { type: 'html' }, render: 'static', lastSuccess: 1 }, prev, deps),
    /kept previous results/
  );
});
