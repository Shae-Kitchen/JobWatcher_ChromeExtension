import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diffJobs,
  extractJobs,
  looksLikeJobUrl,
  matchesFilters,
  normalizeUrl,
  parseKeywords,
} from '../src/lib/extract.js';

test('normalizeUrl resolves relative links and strips tracking params', () => {
  assert.equal(
    normalizeUrl('/jobs/123?utm_source=x&gh_jid=5#apply', 'https://acme.com/careers'),
    'https://acme.com/jobs/123?gh_jid=5'
  );
  assert.equal(normalizeUrl('#/jobs/42', 'https://acme.com/careers'), 'https://acme.com/careers#/jobs/42');
  assert.equal(normalizeUrl('mailto:jobs@acme.com', 'https://acme.com'), null);
  assert.equal(normalizeUrl('javascript:void(0)', 'https://acme.com'), null);
});

test('looksLikeJobUrl accepts postings and rejects careers sub-pages', () => {
  const page = 'https://acme.com/careers';
  assert.ok(looksLikeJobUrl('https://acme.com/careers/senior-engineer-123', page));
  assert.ok(looksLikeJobUrl('https://acme.com/careers?gh_jid=4001', page));
  assert.ok(looksLikeJobUrl('https://jobs.lever.co/acme/1b2c3d4e-0000-1111-2222-333344445555', page));
  assert.ok(looksLikeJobUrl('https://boards.greenhouse.io/acme/jobs/4001', page));
  assert.ok(!looksLikeJobUrl('https://acme.com/careers/benefits', page));
  assert.ok(!looksLikeJobUrl('https://acme.com/about', page));
  assert.ok(!looksLikeJobUrl('https://twitter.com/acme/jobs/1', page));
  assert.ok(!looksLikeJobUrl('https://acme.com/careers', 'https://acme.com/careers/open-roles'));
});

test('extractJobs finds and dedupes job links, skipping generic text', () => {
  const anchors = [
    { href: '/careers/backend-engineer', text: '  Backend\n Engineer ' },
    { href: '/careers/backend-engineer#apply', text: 'Apply' },
    { href: '/careers/backend-engineer?utm_source=li', text: 'Backend Engineer (dup)' },
    { href: '/careers/designer', text: 'Product Designer' },
    { href: '/careers/benefits', text: 'Benefits' },
    { href: '/about', text: 'About us' },
    { href: '/careers/all', text: 'View all jobs' },
  ];
  const jobs = extractJobs({ anchors, pageUrl: 'https://acme.com/careers' });
  assert.deepEqual(
    jobs.map((j) => [j.title, j.url]),
    [
      ['Backend Engineer', 'https://acme.com/careers/backend-engineer'],
      ['Product Designer', 'https://acme.com/careers/designer'],
    ]
  );
});

test('extractJobs with a selector trusts every matched link', () => {
  const anchors = [{ href: '/p/1', text: 'Data Scientist' }];
  assert.equal(extractJobs({ anchors, pageUrl: 'https://acme.com/team' }).length, 0);
  assert.equal(extractJobs({ anchors, pageUrl: 'https://acme.com/team', selector: '.job a' }).length, 1);
});

test('extractJobs honours <base href>', () => {
  const jobs = extractJobs({
    anchors: [{ href: 'jobs/1', text: 'Analyst' }],
    base: '/en/',
    pageUrl: 'https://acme.com/careers',
  });
  assert.equal(jobs[0].url, 'https://acme.com/en/jobs/1');
});

test('keyword filters match title, location and department', () => {
  const job = { title: 'Senior Engineer', location: 'Remote, US', department: 'Platform' };
  assert.ok(matchesFilters(job, parseKeywords('engineer, designer'), []));
  assert.ok(matchesFilters(job, parseKeywords('remote'), []));
  assert.ok(!matchesFilters(job, parseKeywords('designer'), []));
  assert.ok(!matchesFilters(job, [], parseKeywords('senior')));
  assert.ok(matchesFilters(job, [], []));
});

test('diffJobs: baseline marks nothing new', () => {
  const { jobs, newJobs } = diffJobs({}, [{ id: 'a', title: 'A', url: 'u' }], 1000, true);
  assert.equal(newJobs.length, 0);
  assert.equal(jobs.a.isNew, false);
  assert.equal(jobs.a.firstSeen, 1000);
});

test('diffJobs: new, kept, removed and returning jobs', () => {
  const prev = {
    a: { id: 'a', title: 'A', url: 'u', firstSeen: 1, isNew: true, active: true },
    b: { id: 'b', title: 'B', url: 'u', firstSeen: 1, isNew: false, active: true },
    c: { id: 'c', title: 'C', url: 'u', firstSeen: 1, isNew: false, active: false, removedAt: 500 },
  };
  const current = [
    { id: 'a', title: 'A renamed', url: 'u' },
    { id: 'c', title: 'C', url: 'u' },
    { id: 'd', title: 'D', url: 'u' },
  ];
  const { jobs, newJobs, removed } = diffJobs(prev, current, 1000, false);
  assert.deepEqual(newJobs.map((j) => j.id), ['d']);
  assert.equal(jobs.a.title, 'A renamed');
  assert.equal(jobs.a.isNew, true, 'unseen state is preserved');
  assert.equal(jobs.a.firstSeen, 1);
  assert.equal(jobs.b.active, false);
  assert.equal(removed, 1);
  assert.equal(jobs.c.active, true, 'a job that comes back is not new again');
  assert.equal(jobs.c.isNew, false);
  assert.equal('removedAt' in jobs.c, false);
});

test('diffJobs forgets jobs removed more than 30 days ago', () => {
  const prev = { old: { id: 'old', title: 'Old', url: 'u', active: false, removedAt: 0 } };
  const { jobs } = diffJobs(prev, [], 31 * 24 * 3600 * 1000, false);
  assert.deepEqual(jobs, {});
});
