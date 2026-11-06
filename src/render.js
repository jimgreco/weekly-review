// Server-rendered HTML for the review page and the email. Every value from
// the data passes through esc() before it reaches markup.

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const fmt = (n, digits = 0) => (n == null ? '—' : Number(n).toLocaleString('en-US', {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
}));
const money = (n) => (n == null ? '—' : `$${fmt(Math.abs(n), 0)}`);
const signed = (n, digits = 0, unit = '') => {
  if (n == null || n === 0) return n === 0 ? `±0${unit}` : '';
  return `${n > 0 ? '+' : '−'}${fmt(Math.abs(n), digits)}${unit}`;
};
const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
export const weekLabel = (week) => {
  const o = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const a = new Date(`${week.start}T12:00:00Z`).toLocaleDateString('en-US', o);
  const b = new Date(`${week.end}T12:00:00Z`).toLocaleDateString('en-US', o);
  return `${a} – ${b}`;
};

function unavailable(name, source) {
  const why = {
    'no-account': `No ${name} account was found for this email.`,
    disabled: `${name} is turned off for this review.`,
    error: `Couldn't read ${name} this week.`,
  }[source?.status] ?? `${name} is unavailable.`;
  return `<p class="muted">${esc(why)}</p>`;
}

function stat(label, value, sub = '', { text = false } = {}) {
  return `<div class="stat"><div class="label">${esc(label)}</div><div class="value${text ? ' text' : ''}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function nutrition(s) {
  if (s?.status !== 'ok') return unavailable('Macrovana', s);
  const c = s.current;
  const t = s.targets;
  const maxCal = Math.max(t.calories ?? 0, ...c.days.map((d) => d.calories ?? 0), 1);
  const bars = c.days.map((d) => {
    const h = d.calories ? Math.round((d.calories / maxCal) * 100) : 0;
    const cls = d.state === 'complete' ? 'bar' : 'bar partial';
    const title = d.calories ? `${dayName(d.date)}: ${fmt(d.calories)} kcal, ${fmt(d.protein)} g protein (${d.state})` : `${dayName(d.date)}: not logged`;
    return `<div class="col" title="${esc(title)}"><div class="${cls}" style="height:${h}%"></div><span>${esc(dayName(d.date)[0])}</span></div>`;
  }).join('');
  const target = t.calories ? `<div class="target" style="bottom:${Math.round((t.calories / maxCal) * 100)}%"></div>` : '';
  return `
    <div class="stats">
      ${stat('Calories / day', fmt(c.avgCalories), t.calories ? `target ${fmt(t.calories)} · ${esc(signed(s.change.avgCalories))} vs last wk` : esc(signed(s.change.avgCalories)))}
      ${stat('Protein / day', `${fmt(c.avgProtein)} g`, t.protein ? `target ${fmt(t.protein)} g · ${esc(signed(s.change.avgProtein, 0, ' g'))}` : '')}
      ${stat('Complete days', `${c.completeDays}/7`, `${c.loggedDays} logged`)}
      ${c.weight.avg != null ? stat('Weight', `${fmt(c.weight.avg, 1)}`, `${c.weight.count} weigh-ins · ${esc(signed(s.change.weight, 1))}`) : ''}
      ${c.waistIn ? stat('Waist', `${fmt(c.waistIn.latest, 2)} in`, esc(c.waistIn.day)) : ''}
      ${c.sleepScore != null ? stat('Sleep score', fmt(c.sleepScore), `readiness ${fmt(c.readinessScore)} · ${esc(signed(s.change.sleepScore))}`) : ''}
    </div>
    <div class="chart" role="img" aria-label="Calories per day">${target}${bars}</div>
    <p class="note">Averages use Complete days only. Faded bars are days not marked Complete.</p>`;
}

function training(s) {
  if (s?.status !== 'ok') return unavailable('Rep, Mix, Burn', s);
  const c = s.current;
  const rows = c.sessions.map((x) => `
    <li><span class="when">${esc(dayName(x.date))}</span> ${esc(x.name)}${x.optional ? ' <span class="tag">optional</span>' : ''}
      <span class="muted">· ${x.workingSets} sets${x.minutes ? ` · ${x.minutes} min` : ''}</span>
      ${x.personalBests.length ? `<div class="pb">PB: ${x.personalBests.map(esc).join(', ')}</div>` : ''}</li>`).join('');
  const groups = Object.entries(c.setsByMuscleGroup)
    .map(([g, n]) => `<span class="chip">${esc(g)} <b>${n}</b></span>`).join('');
  return `
    <div class="stats">
      ${stat('Sessions', c.sessionCount, `${esc(signed(s.change.sessionCount))} vs last wk${c.skippedCount ? ` · ${c.skippedCount} skipped` : ''}`)}
      ${stat('Working sets', c.workingSets, esc(signed(s.change.workingSets)))}
      ${stat('Personal bests', c.personalBestCount)}
      ${s.program ? stat('Program', esc(s.program.name), esc(s.program.phase ?? ''), { text: true }) : ''}
    </div>
    ${rows ? `<ul class="list">${rows}</ul>` : '<p class="muted">No finished sessions this week.</p>'}
    ${groups ? `<div class="chips">${groups}</div>` : ''}`;
}

function spending(s, week) {
  if (s?.status !== 'ok') return unavailable('Spending', s);
  const stale = s.importsLagging;
  const cats = s.byCategory.map((r) => `
    <tr><td>${esc(r.category)}</td><td class="num">${money(r.total)}</td>
    <td class="num muted">${r.weeklyBaseline ? money(r.weeklyBaseline) : '—'}</td></tr>`).join('');
  const largest = s.largest.map((r) => `
    <li><span class="when">${esc(dayName(r.date))}</span> ${esc(r.description)} <span class="muted">· ${money(r.amount)}</span></li>`).join('');
  return `
    ${stale ? `<p class="warn">Transactions are imported through ${esc(s.latestTransactionDate)}, so this week may be incomplete.</p>` : ''}
    <div class="stats">
      ${stat('Spent', money(s.current.total), `${s.current.count} transactions`)}
      ${stat('Last week', money(s.previous.total), esc(s.change.total == null ? '' : `${s.change.total > 0 ? 'up' : 'down'} ${money(s.change.total)}`))}
      ${stat('8-week average', money(s.weeklyBaseline), 'per week')}
      ${s.needsReview ? stat('To review', s.needsReview, 'uncategorized') : ''}
    </div>
    ${cats ? `<table class="table"><thead><tr><th>Category</th><th class="num">This week</th><th class="num">Usual</th></tr></thead><tbody>${cats}</tbody></table>` : ''}
    ${largest ? `<h3>Largest</h3><ul class="list">${largest}</ul>` : ''}`;
}

function habits(s) {
  if (s?.status !== 'ok') return unavailable('Ritual Cue', s);
  const top = s.mostConsistent.map((r) => `<li>${esc(r.title)} <span class="muted">· ${r.done}/7</span></li>`).join('');
  return `
    <div class="stats">
      ${stat('Check-offs', s.doneCount, `${s.doneCountPrev} last week`)}
      ${stat('Missed', s.missedCount)}
    </div>
    ${top ? `<h3>Most consistent</h3><ul class="list">${top}</ul>` : ''}
    ${s.slipping.length ? `<h3>Dropped off</h3><p>${s.slipping.map(esc).join(', ')} <span class="muted">— done last week, not this week</span></p>` : ''}
    ${s.mostMissed.length ? `<h3>Missed most</h3><p>${s.mostMissed.map((r) => `${esc(r.title)} (${r.missed})`).join(', ')}</p>` : ''}`;
}

function taskLine(t) {
  const bits = [t.responsible, t.deadline && `due ${dayName(t.deadline)} ${t.deadline.slice(5)}`, t.carryovers >= 2 && `carried ${t.carryovers}×`].filter(Boolean);
  return `<li>${esc(t.text)}${bits.length ? ` <span class="muted">· ${bits.map(esc).join(' · ')}</span>` : ''}</li>`;
}

function planner(s) {
  if (s?.status !== 'ok') return unavailable('Week of Us', s);
  const notes = s.nextWeek.notes;
  const noteRows = notes ? ['priorities', 'meals', 'logistics']
    .filter((k) => notes[k])
    .map((k) => `<div class="kv"><span>${esc(k[0].toUpperCase() + k.slice(1))}</span><p>${esc(notes[k])}</p></div>`).join('') : '';
  return `
    <div class="stats">
      ${stat('Tasks done', `${s.current.doneCount}/${s.current.taskCount}`)}
      ${stat('Overdue', s.overdue.length)}
    </div>
    ${s.current.stuck.length ? `<h3>Stuck</h3><ul class="list">${s.current.stuck.map(taskLine).join('')}</ul>` : ''}
    ${s.overdue.length ? `<h3>Overdue</h3><ul class="list">${s.overdue.map(taskLine).join('')}</ul>` : ''}`
    + `<h3>Coming up</h3>${noteRows}${s.nextWeek.tasks.length ? `<ul class="list">${s.nextWeek.tasks.map(taskLine).join('')}</ul>` : '<p class="muted">Nothing planned yet.</p>'}`;
}

const CSS = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d1d1b;--muted:#6d6a63;--line:#e4e1d8;--accent:#2f6f5e;--accent-soft:#d8e9e3;--warn:#8a5a00;--warn-bg:#fbefd5}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a19e95;--line:#33322e;--accent:#7cc3ad;--accent-soft:#25403a;--warn:#f0c46a;--warn-bg:#3a2f17}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}
header h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}header p{margin:0;color:var(--muted)}
.narrative{font-size:17px;line-height:1.6;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:12px;padding:18px 20px;margin:20px 0}
.narrative p{margin:0 0 .8em}.narrative p:last-child{margin:0}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:16px 0}
section h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px}
h3{font-size:14px;margin:16px 0 6px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px}
.stat .label{font-size:12px;color:var(--muted)}.stat .value{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}.stat .sub{font-size:12px;color:var(--muted)}
.chart{position:relative;display:flex;gap:6px;align-items:flex-end;height:110px;margin:18px 0 4px;padding-bottom:18px}
.col{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
.col span{position:absolute;bottom:0;font-size:11px;color:var(--muted)}.col{position:relative}
.bar{width:100%;background:var(--accent);border-radius:4px 4px 0 0;min-height:2px}.bar.partial{opacity:.35}
.target{position:absolute;left:0;right:0;border-top:1px dashed var(--muted);margin-bottom:18px}
.note,.muted{color:var(--muted)}.note{font-size:12px;margin:4px 0 0}
.list{list-style:none;padding:0;margin:8px 0 0}.list li{padding:6px 0;border-top:1px solid var(--line)}.list li:first-child{border-top:0}
.when{display:inline-block;min-width:36px;color:var(--muted);font-size:13px}
.pb{font-size:13px;color:var(--accent);margin-left:36px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.chip{background:var(--accent-soft);border-radius:999px;padding:2px 10px;font-size:13px}
.tag{font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 4px;color:var(--muted)}
.table{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px}.table th{text-align:left;font-weight:500;color:var(--muted);font-size:12px}
.table td,.table th{padding:6px 0;border-top:1px solid var(--line)}.num,.table .num{text-align:right;font-variant-numeric:tabular-nums}
.stat .value.text{font-size:16px;line-height:1.3;padding-top:4px}
.warn{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:8px 12px;font-size:14px}
.kv{display:grid;grid-template-columns:90px 1fr;gap:8px;font-size:14px}.kv span{color:var(--muted)}.kv p{margin:0 0 6px}
footer{text-align:center;font-size:13px;color:var(--muted);margin-top:24px}footer a{color:var(--muted)}
a{color:var(--accent)}`;

export function paragraphs(text) {
  return String(text).split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join('');
}

export function renderPage(review, { archiveHref } = {}) {
  const s = review.sources;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Week of ${esc(weekLabel(review.week))}</title><style>${CSS}</style></head><body><main>
<header><h1>Week of ${esc(weekLabel(review.week))}</h1><p>Your weekly review</p></header>
${review.narrative ? `<div class="narrative">${paragraphs(review.narrative.text)}</div>` : ''}
<section><h2>Nutrition &amp; recovery</h2>${nutrition(s.macros)}</section>
<section><h2>Training</h2>${training(s.workouts)}</section>
<section><h2>Spending</h2>${spending(s.spending, review.week)}</section>
<section><h2>Habits</h2>${habits(s.checklist)}</section>
<section><h2>Household</h2>${planner(s.planner)}</section>
<footer>Generated ${esc(new Date(review.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }))}${archiveHref ? ` · <a href="${esc(archiveHref)}">Past weeks</a>` : ''}</footer>
</main></body></html>`;
}

export function renderArchive(entries) {
  const rows = entries.map((e) => `<li><a href="${esc(e.href)}">Week of ${esc(e.label)}</a></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Past reviews</title><style>${CSS}</style></head><body><main>
<header><h1>Past reviews</h1></header><section>${rows ? `<ul class="list">${rows}</ul>` : '<p class="muted">No reviews yet.</p>'}</section>
</main></body></html>`;
}

/** A one-line-per-source summary used in the email and plain-text part. */
export function headlines(review) {
  const s = review.sources;
  const out = [];
  if (s.macros?.status === 'ok') {
    const c = s.macros.current;
    out.push(`Nutrition: ${fmt(c.avgCalories)} kcal and ${fmt(c.avgProtein)} g protein a day over ${c.completeDays} complete days`);
  }
  if (s.workouts?.status === 'ok') {
    const c = s.workouts.current;
    out.push(`Training: ${c.sessionCount} sessions, ${c.workingSets} working sets${c.personalBestCount ? `, ${c.personalBestCount} PBs` : ''}`);
  }
  if (s.spending?.status === 'ok') {
    out.push(`Spending: ${money(s.spending.current.total)} (usual week ${money(s.spending.weeklyBaseline)})`);
  }
  if (s.checklist?.status === 'ok') {
    out.push(`Habits: ${s.checklist.doneCount} check-offs (${s.checklist.doneCountPrev} last week)`);
  }
  if (s.planner?.status === 'ok') {
    const p = s.planner;
    out.push(`Household: ${p.current.doneCount} of ${p.current.taskCount} tasks done${p.overdue.length ? `, ${p.overdue.length} overdue` : ''}`);
  }
  return out;
}

export function renderEmail(review, url) {
  const lines = headlines(review);
  const narrative = review.narrative?.text ?? '';
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5f1;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1b">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<h1 style="font-size:22px;margin:0 0 16px">Week of ${esc(weekLabel(review.week))}</h1>
${narrative ? `<div style="background:#fff;border-left:4px solid #2f6f5e;border-radius:8px;padding:14px 16px;margin-bottom:16px">${paragraphs(narrative).replace(/<p>/g, '<p style="margin:0 0 10px">')}</div>` : ''}
<ul style="padding-left:18px;margin:0 0 20px">${lines.map((l) => `<li style="margin:4px 0">${esc(l)}</li>`).join('')}</ul>
<a href="${esc(url)}" style="display:inline-block;background:#2f6f5e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">Open the full review</a>
<p style="font-size:12px;color:#6d6a63;margin-top:24px">This link is private to you. Anyone you forward it to can open this week's review.</p>
</div></body></html>`;
  const text = [`Week of ${weekLabel(review.week)}`, '', narrative, '', ...lines.map((l) => `- ${l}`), '', `Full review: ${url}`]
    .filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return { subject: `Your week: ${weekLabel(review.week)}`, html, text };
}
