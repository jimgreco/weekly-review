// Manual runs. Examples:
//   node src/cli.js --week 2026-10-26 --no-send            build + save, no email
//   node src/cli.js --week 2026-10-26 --no-send --out x.html   also write the page to a file
//   node src/cli.js --no-send --no-narrative --json          print collected data only
//   node src/cli.js --week 2026-10-26 --link                 print the private link
import { writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { runReview } from './run.js';
import { collectWeek } from './collect.js';
import { renderPage } from './render.js';
import { reviewUrl, archiveUrl } from './links.js';
import { currentWeek, previousWeek, weekRange } from './week.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig();
const weekArg = option('--week');
// Default: the last fully finished week.
const week = weekArg ? weekRange(weekArg) : previousWeek(currentWeek(new Date(), config.timezone));

if (flag('--link')) {
  console.log(reviewUrl(config, week.start));
  console.log(archiveUrl(config));
} else if (flag('--json')) {
  console.log(JSON.stringify(await collectWeek(config, week), null, 2));
} else {
  const store = createStore(config.dataDir);
  const review = await runReview(config, store, week, {
    send: !flag('--no-send'),
    narrative: config.narrativeEnabled && !flag('--no-narrative'),
  });
  const out = option('--out');
  if (out) await writeFile(out, renderPage(review));
  const statuses = Object.entries(review.sources).map(([k, v]) => `${k}=${v.status}`).join(' ');
  console.log(`Week ${week.start}: ${statuses}; narrative=${review.narrative ? 'yes' : 'no'}; sent=${review.sentAt ?? 'no'}`);
  if (out) console.log(`Wrote ${out}`);
}
