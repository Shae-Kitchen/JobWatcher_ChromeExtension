import { diffJobs, matchesFilters, parseKeywords } from './extract.js';
import { fetchJobs } from './sources.js';

/**
 * Check one watch: fetch its listing, apply keyword filters and diff against
 * the previously stored jobs. The first successful check (or the first after
 * the watch's URL/filters change) is a baseline, so existing jobs are not
 * reported as new.
 */
export async function checkWatch(watch, prevJobs, deps) {
  const { jobs: all, via } = await fetchJobs(watch, deps);
  const include = parseKeywords(watch.include);
  const exclude = parseKeywords(watch.exclude);
  const matching = all.filter((job) => job.id && job.url && job.title && matchesFilters(job, include, exclude));

  const prevActive = Object.values(prevJobs).filter((j) => j.active !== false).length;
  if (all.length === 0 && prevActive > 0) {
    // An empty page is far more often a fetch/layout problem than every job
    // closing at once, so keep the previous results rather than wiping them.
    throw new Error('No jobs found this time; kept previous results. The page may have changed.');
  }

  const baseline = !watch.lastSuccess || Boolean(watch.needsBaseline);
  const result = diffJobs(prevJobs, matching, deps.now ?? Date.now(), baseline);
  return { ...result, baseline, via, totalOnPage: all.length };
}
