// Commands. The weekly routine runs collect, writes the narrative, then publish.
//
//   node src/cli.js collect [--week 2026-11-02] [--out review.json]
//       Call every app's weekly-summary endpoint and write the review JSON.
//       Default week: the current one on Sunday, otherwise the last finished week.
//   node src/cli.js publish --in review.json [--narrative narrative.md] [--model id] [--send]
//       Post the review (and narrative) to the review site. --send emails the
//       link, at most once per week.
//   node src/cli.js render --in review.json [--narrative narrative.md] --out page.html
//       Write the page locally, to check it before publishing.
//   node src/cli.js link [--week 2026-11-02]
//       On the review site: print the private links for a week and the archive.
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { collectWeek } from './sources.js';
import { renderPage } from './render.js';
import { reviewUrl, archiveUrl } from './links.js';
import { currentWeek, localParts, previousWeek, weekRange } from './week.js';

const [command, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const config = loadConfig();

export function defaultWeek(now, timezone) {
  const week = currentWeek(now, timezone);
  return localParts(now, timezone).weekday === 0 ? week : previousWeek(week);
}

async function loadSubmission() {
  const input = option('--in');
  if (!input) throw new Error('--in <review.json> is required');
  const review = JSON.parse(await readFile(input, 'utf8'));
  const narrativeFile = option('--narrative');
  const text = narrativeFile ? (await readFile(narrativeFile, 'utf8')).trim() : '';
  return { review, narrative: text ? { text, model: option('--model') ?? null } : null };
}

async function main() {
  const week = option('--week') ? weekRange(option('--week')) : defaultWeek(new Date(), config.timezone);

  if (command === 'collect') {
    const review = await collectWeek(config, week);
    const json = JSON.stringify(review, null, 2);
    const out = option('--out');
    if (out) await writeFile(out, json, { mode: 0o600 });
    else console.log(json);
    const statuses = Object.entries(review.sources).map(([k, v]) => `${k}=${v.status}${v.error ? ` (${v.error})` : ''}`);
    console.error(`Week ${week.start}: ${statuses.join(', ')}`);
    return;
  }

  if (command === 'publish') {
    if (!config.siteUrl || (!config.ingestToken && !config.authViaProxy)) {
      throw new Error('REVIEW_SITE_URL and REVIEW_INGEST_TOKEN (or AUTH_VIA_PROXY=1) are required');
    }
    const { review, narrative } = await loadSubmission();
    const response = await fetch(`${config.siteUrl}/api/reviews`, {
      method: 'POST',
      headers: config.ingestToken
        ? { Authorization: `Bearer ${config.ingestToken}`, 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review, narrative, send: flag('--send') }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Review site returned ${response.status}: ${body.slice(0, 300)}`);
    const result = JSON.parse(body);
    console.log(`Published ${result.week}; ${result.sent ? 'emailed now' : result.sentAt ? `already emailed at ${result.sentAt}` : 'not emailed'}`);
    return;
  }

  if (command === 'render') {
    const { review, narrative } = await loadSubmission();
    const out = option('--out');
    if (!out) throw new Error('--out <page.html> is required');
    await writeFile(out, renderPage({ ...review, narrative }));
    console.log(`Wrote ${out}`);
    return;
  }

  if (command === 'link') {
    console.log(reviewUrl(config, week.start));
    console.log(archiveUrl(config));
    return;
  }

  console.error('Usage: node src/cli.js <collect|publish|render|link> [options]; see the top of src/cli.js');
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
