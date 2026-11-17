// Server-rendered HTML for the review page and the email. Every value from
// the data passes through esc() before it reaches markup.
import { addDays } from './week.js';

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

// Each section comes from another app's API. A response that says "ok" but is
// missing fields must cost only its own section, not the page or the email.
function section(name, render, source, ...rest) {
  try {
    return render(source, ...rest);
  } catch (error) {
    console.error(`[render] ${name} data has an unexpected shape:`, error.message);
    return `<p class="muted">${esc(`Couldn't display ${name} this week.`)}</p>`;
  }
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
      ${c.health?.avgSteps != null ? stat('Steps / day', fmt(c.health.avgSteps), `${c.health.daysWithData} days${s.change?.health?.avgSteps != null ? ` · ${esc(signed(s.change.health.avgSteps))} vs last wk` : ''}`) : ''}
      ${c.health?.avgDistanceMiles != null ? stat('Distance / day', `${fmt(c.health.avgDistanceMiles, 1)} mi`, s.change?.health?.avgDistanceMiles != null ? `${esc(signed(s.change.health.avgDistanceMiles, 1, ' mi'))} vs last wk` : '') : ''}
      ${c.health?.avgHeartRateBpm != null ? stat('Heart rate', `${fmt(c.health.avgHeartRateBpm)} bpm`, c.health.avgLowestHeartRateBpm != null ? `lowest ${fmt(c.health.avgLowestHeartRateBpm)} bpm` : '') : ''}
      ${c.health?.avgRestingHeartRate != null ? stat('Resting HR', `${fmt(c.health.avgRestingHeartRate, 1)} bpm`, s.change?.health?.avgRestingHeartRate != null ? esc(signed(s.change.health.avgRestingHeartRate, 1, ' bpm')) : '') : ''}
      ${c.health?.avgHrvMs != null ? stat('HRV', `${fmt(c.health.avgHrvMs, 1)} ms`, s.change?.health?.avgHrvMs != null ? esc(signed(s.change.health.avgHrvMs, 1, ' ms')) : '') : ''}
      ${c.avgSleepHours != null ? stat('Sleep / night', `${fmt(c.avgSleepHours, 1)} h`, `${c.sleepNights} nights${t.sleepHours ? ` · target ${fmt(t.sleepHours, 1)} h` : ''}${s.change?.avgSleepHours != null ? ` · ${esc(signed(s.change.avgSleepHours, 1, ' h'))}` : ''}`) : ''}
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

const AREA_LABEL = { nutrition: 'Nutrition', training: 'Training', activity: 'Activity', money: 'Money', habits: 'Habits', home: 'Home', other: 'Other' };
const OUTCOME_LABEL = { hit: 'Hit', partial: 'Partly', miss: 'Missed', unknown: 'No data' };

function commitmentBody(c) {
  return `<div class="c-text"><span class="c-name">${esc(c.text)}</span> <span class="tag">${esc(AREA_LABEL[c.area] ?? 'Other')}</span></div>
      ${c.measure ? `<div class="c-sub">Counts if: ${esc(c.measure)}</div>` : ''}`;
}

// Last week's accepted commitments with how they went (scored by this review).
function commitmentsDue(record, { title = "Last week's commitments" } = {}) {
  const accepted = record.items.filter((c) => c.decision === 'accepted');
  const hit = accepted.filter((c) => c.outcome === 'hit').length;
  const rows = accepted.map((c) => `
    <li class="commit"><div class="c-main">${commitmentBody(c)}
      ${c.note ? `<div class="c-sub">${esc(c.note)}</div>` : ''}</div>
      <span class="badge ${esc(c.outcome ?? 'pending')}">${esc(OUTCOME_LABEL[c.outcome] ?? 'Not scored yet')}</span></li>`).join('');
  return `<section id="scorecard"><h2>${esc(title)}</h2>
    ${record.scoredAt ? `<div class="stats">${stat('Kept', `${hit}/${accepted.length}`, 'accepted commitments hit')}</div>` : ''}
    <ul class="list">${rows}</ul></section>`;
}

// The commitments this review proposes for the coming week. With decideHref
// each one gets Accept / Decline buttons (plain form posts, no script).
function commitmentsNext(record, decideHref, { title = 'Commitments for the coming week', id = 'commitments', hidden = {}, when = 'Next' } = {}) {
  const open = decideHref && !record.scoredAt;
  const extra = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const button = (c, decision, label, cls = '') => `<form method="post" action="${esc(decideHref)}">${extra}<input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="decision" value="${decision}"><button type="submit"${cls ? ` class="${cls}"` : ''}>${label}</button></form>`;
  const rows = record.items.map((c) => {
    const state = c.decision === 'accepted' ? '<span class="badge hit">Accepted</span>'
      : c.decision === 'declined' ? '<span class="badge unknown">Declined</span>' : '';
    const actions = !open ? state
      : c.decision ? `${state}${button(c, 'undo', 'Change', 'quiet')}`
        : `${button(c, 'accept', 'Accept', 'primary')}${button(c, 'decline', 'Decline')}`;
    return `
    <li class="commit${c.decision === 'declined' ? ' declined' : ''}"><div class="c-main">${commitmentBody(c)}</div>
      <div class="c-actions">${actions}</div></li>`;
  }).join('');
  const accepted = record.items.filter((c) => c.decision === 'accepted').length;
  const hint = record.scoredAt ? 'This week has been scored.'
    : !decideHref ? ''
      : accepted ? `${accepted} accepted. ${when} Sunday's review scores only the ones you accept.`
        : `Accept the ones you'll commit to. ${when} Sunday's review scores only those.`;
  return `<section id="${esc(id)}"><h2>${esc(title)}</h2>
    <ul class="list">${rows}</ul>${hint ? `<p class="note">${esc(hint)}</p>` : ''}</section>`;
}

function commitmentSections({ due, next } = {}, decideHref) {
  let html = '';
  try {
    if (due?.items?.some((c) => c.decision === 'accepted')) html += commitmentsDue(due);
    if (next?.items?.length) html += commitmentsNext(next, decideHref);
  } catch (error) {
    console.error('[render] commitments have an unexpected shape:', error.message);
  }
  return html;
}

const CSS = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d1d1b;--muted:#6d6a63;--line:#e4e1d8;--accent:#2f6f5e;--accent-soft:#d8e9e3;--warn:#8a5a00;--warn-bg:#fbefd5}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a19e95;--line:#33322e;--accent:#7cc3ad;--accent-soft:#25403a;--warn:#f0c46a;--warn-bg:#3a2f17}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}
header h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}header p{margin:0;color:var(--muted)}
.narrative{font-size:17px;line-height:1.6;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:12px;padding:18px 20px;margin:20px 0}
.narrative p{margin:0 0 .8em}.narrative p:last-child{margin:0}
.narrative h3{font-size:15px;letter-spacing:.02em;text-transform:uppercase;color:var(--accent);margin:1.2em 0 .4em}.narrative h3:first-child{margin-top:0}
.narrative ul{margin:0 0 .8em;padding-left:1.2em}.narrative li{margin:.25em 0}
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
.table td,.table th{padding:6px 8px 6px 0;border-top:1px solid var(--line)}.table-wrap{overflow-x:auto;margin:0 0 12px}.num,.table .num{text-align:right;font-variant-numeric:tabular-nums}
.stat .value.text{font-size:16px;line-height:1.3;padding-top:4px}
.warn{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:8px 12px;font-size:14px}
.kv{display:grid;grid-template-columns:90px 1fr;gap:8px;font-size:14px}.kv span{color:var(--muted)}.kv p{margin:0 0 6px}
.commit{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}.commit.declined .c-name{color:var(--muted);text-decoration:line-through}
.c-main{flex:1 1 260px;min-width:0}.c-sub{font-size:13px;color:var(--muted);margin-top:2px}
.c-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.c-actions form{margin:0}
.c-actions button{font:inherit;font-size:14px;min-height:36px;padding:4px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
.c-actions button.primary{background:var(--accent);border-color:var(--accent);color:var(--card)}.c-actions button.quiet{font-size:13px;color:var(--muted);min-height:28px;padding:2px 10px}
.badge{font-size:12px;border-radius:999px;padding:2px 10px;white-space:nowrap;background:var(--line);color:var(--muted)}
.badge.hit{background:var(--accent-soft);color:var(--accent)}.badge.partial,.badge.miss{background:var(--warn-bg);color:var(--warn)}
footer{text-align:center;font-size:13px;color:var(--muted);margin-top:24px}footer a{color:var(--muted)}
a{color:var(--accent)}`;

// A tiny, safe subset of Markdown for the narrative: blank-line paragraphs,
// `## ` headings, `- ` bullet lists and **bold**. Everything is escaped first,
// so the text can never inject markup. `style` adds inline styles for email.
// A Markdown pipe table: header row, a |---|---:| separator, body rows.
// Right-aligned (---:) columns get the numeric style. Rows wider than the
// header are cut; narrower ones are padded.
function table(lines, inline, attr) {
  const cells = (l) => l.slice(1, -1).split('|').map((c) => c.trim());
  const head = cells(lines[0]);
  const hasSep = lines[1] && cells(lines[1]).every((c) => /^:?-{2,}:?$/.test(c));
  const align = hasSep ? cells(lines[1]).map((c) => (c.endsWith(':') ? ' class="num"' : '')) : [];
  const body = lines.slice(hasSep ? 2 : 1).map(cells);
  const row = (r, tag) => `<tr>${head.map((_, i) => `<${tag}${align[i] ?? ''}>${inline(r[i] ?? '')}</${tag}>`).join('')}</tr>`;
  return `<div class="table-wrap"><table class="table"${attr('table')}><thead>${row(head, 'th')}</thead><tbody>${body.map((r) => row(r, 'td')).join('')}</tbody></table></div>`;
}

export function paragraphs(text, style = {}) {
  const attr = (tag) => (style[tag] ? ` style="${style[tag]}"` : '');
  const inline = (line) => esc(line).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return String(text).split(/\n\s*\n/).map((block) => {
    const lines = block.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (lines.length === 1 && /^#{2,3} /.test(lines[0])) return `<h3${attr('h3')}>${inline(lines[0].replace(/^#{2,3} /, ''))}</h3>`;
    const out = [];
    let heading = null;
    if (/^#{2,3} /.test(lines[0])) heading = lines.shift().replace(/^#{2,3} /, '');
    if (heading) out.push(`<h3${attr('h3')}>${inline(heading)}</h3>`);
    if (lines.length >= 2 && lines.every((l) => /^\|.*\|$/.test(l))) {
      out.push(table(lines, inline, attr));
    } else if (lines.every((l) => /^[-*] /.test(l))) {
      out.push(`<ul${attr('ul')}>${lines.map((l) => `<li${attr('li')}>${inline(l.slice(2))}</li>`).join('')}</ul>`);
    } else {
      out.push(`<p${attr('p')}>${lines.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }).join('');
}

export function renderPage(review, { archiveHref, commitments, decideHref } = {}) {
  const s = review.sources;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Week of ${esc(weekLabel(review.week))}</title><style>${CSS}</style></head><body><main>
<header><h1>Week of ${esc(weekLabel(review.week))}</h1><p>Your weekly review</p></header>
${review.narrative ? `<div class="narrative">${paragraphs(review.narrative.text)}</div>` : ''}
${commitmentSections(commitments, decideHref)}
<section><h2>Nutrition &amp; recovery</h2>${section('Macrovana', nutrition, s.macros)}</section>
<section><h2>Training</h2>${section('Rep, Mix, Burn', training, s.workouts)}</section>
<section><h2>Spending</h2>${section('Spending', spending, s.spending, review.week)}</section>
<section><h2>Habits</h2>${section('Ritual Cue', habits, s.checklist)}</section>
<section><h2>Household</h2>${section('Week of Us', planner, s.planner)}</section>
<footer>Generated ${esc(new Date(review.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }))}${archiveHref ? ` · <a href="${esc(archiveHref)}">Past weeks</a>` : ''}</footer>
</main></body></html>`;
}

const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** The heading for a post (src/posts.js). `decision` is its register entry, for decision briefs. */
export function describePost(post, decision = null) {
  if (post.kind === 'pulse') return { title: 'Midweek check', subtitle: `Week of ${weekLabel({ start: post.key, end: new Date(Date.parse(`${post.key}T12:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10) })}` };
  if (post.kind === 'monthly') {
    return { title: new Date(`${post.key}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), subtitle: 'Your month in review' };
  }
  if (post.kind === 'decision') return decision ? { title: decision.title, subtitle: `Decision brief for ${longDate(decision.date)}` } : null;
  if (post.kind === 'checkin') return { title: 'Nutrition & training check-in', subtitle: `Week ending ${longDate(addDays(post.key, -1))}` };
  return null;
}

export function renderPost(post, { archiveHref, backHref, backLabel } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(post.title)}</title><style>${CSS}</style></head><body><main>
<header><h1>${esc(post.title)}</h1><p>${esc(post.subtitle)}</p></header>
<div class="narrative">${paragraphs(post.text)}</div>
${backHref ? `<p><a href="${esc(backHref)}">${esc(backLabel)}</a></p>` : ''}
<footer>Generated ${esc(new Date(post.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }))}${archiveHref ? ` · <a href="${esc(archiveHref)}">Past weeks</a>` : ''}</footer>
</main></body></html>`;
}

/** Email for a post. `link` is {href, label}: the button under the text. */
export function renderPostEmail(post, link) {
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5f1;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1b">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<h1 style="font-size:22px;margin:0 0 4px">${esc(post.title)}</h1>
<p style="margin:0 0 16px;color:#6d6a63">${esc(post.subtitle)}</p>
<div style="background:#fff;border-left:4px solid #2f6f5e;border-radius:8px;padding:14px 16px;margin-bottom:16px">${paragraphs(post.text, { p: 'margin:0 0 10px', h3: 'font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#2f6f5e;margin:16px 0 6px', ul: 'margin:0 0 10px;padding-left:18px', li: 'margin:3px 0' })}</div>
<a href="${esc(link.href)}" style="display:inline-block;background:#2f6f5e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">${esc(link.label)}</a>
<p style="font-size:12px;color:#6d6a63;margin-top:24px">This link is private to you. Anyone you forward it to can open it.</p>
</div></body></html>`;
  const subject = { pulse: `Midweek check: ${post.subtitle.replace(/^Week of /, '')}`, monthly: `Your month: ${post.title}`, decision: `Decision brief: ${post.title}`, checkin: `Check-in: ${post.subtitle.replace(/^Week ending /, 'week ending ')}` }[post.kind];
  return { subject, html, text: [post.title, post.subtitle, '', post.text, '', `${link.label}: ${link.href}`].join('\n') };
}

export function renderArchive(entries, groups = []) {
  const rows = entries.map((e) => `<li><a href="${esc(e.href)}">Week of ${esc(e.label)}</a></li>`).join('');
  const extra = groups.filter((g) => g.entries.length).map((g) => `<section><h2>${esc(g.title)}</h2><ul class="list">${g.entries.map((e) => `<li><a href="${esc(e.href)}">${esc(e.label)}</a></li>`).join('')}</ul></section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Past reviews</title><style>${CSS}</style></head><body><main>
<header><h1>Past reviews</h1></header><section>${extra ? '<h2>Weekly reviews</h2>' : ''}${rows ? `<ul class="list">${rows}</ul>` : '<p class="muted">No reviews yet.</p>'}</section>${extra}
</main></body></html>`;
}

/** A one-line-per-source summary used in the email and plain-text part. */
export function headlines(review) {
  const s = review.sources;
  const lines = {
    macros: (m) => `Nutrition: ${fmt(m.current.avgCalories)} kcal and ${fmt(m.current.avgProtein)} g protein a day over ${m.current.completeDays} complete days`,
    workouts: (w) => `Training: ${w.current.sessionCount} sessions, ${w.current.workingSets} working sets${w.current.personalBestCount ? `, ${w.current.personalBestCount} PBs` : ''}`,
    spending: (x) => `Spending: ${money(x.current.total)} (usual week ${money(x.weeklyBaseline)})`,
    checklist: (c) => `Habits: ${c.doneCount} check-offs (${c.doneCountPrev} last week)`,
    planner: (p) => `Household: ${p.current.doneCount} of ${p.current.taskCount} tasks done${p.overdue.length ? `, ${p.overdue.length} overdue` : ''}`,
  };
  const out = [];
  for (const [key, line] of Object.entries(lines)) {
    if (s[key]?.status !== 'ok') continue;
    try {
      out.push(line(s[key]));
    } catch (error) {
      console.error(`[render] ${key} headline skipped:`, error.message);
    }
  }
  return out;
}

export function renderEmail(review, url, { hasCommitments = false } = {}) {
  const lines = headlines(review);
  const narrative = review.narrative?.text ?? '';
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5f1;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1b">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<h1 style="font-size:22px;margin:0 0 16px">Week of ${esc(weekLabel(review.week))}</h1>
${narrative ? `<div style="background:#fff;border-left:4px solid #2f6f5e;border-radius:8px;padding:14px 16px;margin-bottom:16px">${paragraphs(narrative, { p: 'margin:0 0 10px', h3: 'font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#2f6f5e;margin:16px 0 6px', ul: 'margin:0 0 10px;padding-left:18px', li: 'margin:3px 0' })}</div>` : ''}
<ul style="padding-left:18px;margin:0 0 20px">${lines.map((l) => `<li style="margin:4px 0">${esc(l)}</li>`).join('')}</ul>
<a href="${esc(url)}" style="display:inline-block;background:#2f6f5e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">${hasCommitments ? 'Open the review and choose your commitments' : 'Open the full review'}</a>
<p style="font-size:12px;color:#6d6a63;margin-top:24px">This link is private to you. Anyone you forward it to can open this week's review.</p>
</div></body></html>`;
  const text = [`Week of ${weekLabel(review.week)}`, '', narrative, '', ...lines.map((l) => `- ${l}`), '', `${hasCommitments ? 'Choose your commitments for the week on the full review' : 'Full review'}: ${url}`]
    .filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return { subject: `Your week: ${weekLabel(review.week)}`, html, text };
}

// ---- Claude Code summaries (Google sign-in protected, /summaries) ----

const SUMMARY_CSS = `${CSS}
.nav{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:14px;margin:8px 0}
.signout{display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap}
.signout button{font:inherit;font-size:13px;color:var(--muted);background:none;border:1px solid var(--line);border-radius:6px;padding:2px 10px;cursor:pointer}
.gsi{display:flex;justify-content:center;min-height:44px;margin-top:12px}
.top{display:flex;gap:16px;flex-wrap:wrap;font-size:14px;margin:12px 0 0}.top a[aria-current]{color:var(--ink);font-weight:600;text-decoration:none}
.row{display:flex;gap:12px;justify-content:space-between;align-items:baseline;flex-wrap:wrap}.row .muted{font-size:13px}
details{margin-top:8px}summary{cursor:pointer;color:var(--muted);font-size:14px}
.field{display:block;margin:0 0 14px}.field span{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}
.field input,.field textarea,.field select{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.field textarea{min-height:96px;resize:vertical}.field small{display:block;color:var(--muted);font-size:12px;margin-top:3px}
.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.btn{display:inline-block;font:inherit;font-size:14px;min-height:36px;padding:6px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--card);cursor:pointer;text-decoration:none}
.error{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:8px 12px;font-size:14px;margin:0 0 14px}
.d-q{color:var(--muted);font-size:14px;margin:2px 0 0}.d-out{font-size:14px;margin:4px 0 0}`;

const topNav = (current) => `<nav class="top">${[['/home', 'Home'], ['/decisions', 'Decisions'], ['/summaries', 'Claude Code summaries']]
  .map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const nextSunday = (monday) => new Date(Date.parse(`${monday}T12:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);

/** The signed-in home page (src/home.js). */
export function renderHome(d, { email, csrf }) {
  const label = (record) => weekLabel({ start: record.week, end: nextSunday(record.week) });
  const live = (record, title, id, when) => (record.scoredAt
    ? commitmentsDue(record, { title }).replace('id="scorecard"', `id="${id}"`)
    : commitmentsNext(record, '/home/commitments', { title, id, when, hidden: { week: record.week, csrf } }));
  let commitments = '';
  try {
    if (d.nextWeek?.items?.length) commitments += live(d.nextWeek, `Next week's commitments · ${label(d.nextWeek)}`, 'commitments', 'Next');
    if (d.thisWeek?.items?.length) commitments += live(d.thisWeek, `This week's commitments · ${label(d.thisWeek)}`, d.nextWeek?.items?.length ? 'this-week' : 'commitments', 'This');
  } catch (error) {
    console.error('[render] commitments have an unexpected shape:', error.message);
  }
  if (!commitments) commitments = '<section id="commitments"><h2>Commitments</h2><p class="muted">None yet. The next Sunday review proposes them, and you accept or decline them here.</p></section>';

  const scored = d.history.filter((h) => h.scored && h.accepted);
  const kept = scored.reduce((n, h) => n + h.hit, 0);
  const accepted = scored.reduce((n, h) => n + h.accepted, 0);
  const follow = d.history.length ? `<section><h2>Follow-through</h2>
    ${scored.length ? `<div class="stats">${stat('Kept', `${kept}/${accepted}`, `over ${scored.length} scored week${scored.length === 1 ? '' : 's'}`)}</div>` : ''}
    <ul class="list">${[...d.history].reverse().map((h) => `<li class="row"><span>${esc(h.label)}</span><span class="muted">${esc(
    !h.accepted ? `${h.proposed} proposed, none accepted`
      : !h.scored ? `${h.accepted} accepted, not scored yet`
        : [`${h.hit} hit`, h.partial && `${h.partial} partly`, h.miss && `${h.miss} missed`, h.unknown && `${h.unknown} no data`].filter(Boolean).join(' · ') + ` of ${h.accepted}`)}</span></li>`).join('')}</ul></section>` : '';

  const latest = [
    d.reviews[0] && ['Weekly review', `Week of ${d.reviews[0].label}`, d.reviews[0].href],
    d.checkins[0] && ['Nutrition & training check-in', d.checkins[0].subtitle, d.checkins[0].href],
    d.pulses[0] && ['Midweek check', d.pulses[0].subtitle, d.pulses[0].href],
    d.months[0] && ['Month', d.months[0].title, d.months[0].href],
    d.summaries[0] && ['Claude Code summary', `Week of ${d.summaries[0].label}`, d.summaries[0].href],
  ].filter(Boolean).map(([kind, name, href]) => `<li class="row"><a href="${esc(href)}">${esc(name)}</a><span class="muted">${esc(kind)}</span></li>`).join('');

  const upcoming = d.upcoming.map((x) => `<li><div class="row"><span>${esc(x.title)}</span><span class="muted">${esc(shortDate(x.date))}</span></div>
    <p class="d-q">${esc(x.question)}${x.briefHref ? ` · <a href="${esc(x.briefHref)}">Read the brief</a>` : ''}</p></li>`).join('');

  const group = (title, entries, text) => (entries.length ? `<details${entries.length <= 6 ? ' open' : ''}><summary>${esc(title)} (${entries.length})</summary><ul class="list">${entries.map((e) => `<li><a href="${esc(e.href)}">${esc(text(e))}</a></li>`).join('')}</ul></details>` : '');
  const archive = group('Weekly reviews', d.reviews, (e) => `Week of ${e.label}`)
    + group('Nutrition & training check-ins', d.checkins, (e) => e.subtitle) + group('Months', d.months, (e) => e.title)
    + group('Decision briefs', d.briefs, (e) => e.title) + group('Midweek checks', d.pulses, (e) => e.subtitle)
    + group('Claude Code summaries', d.summaries, (e) => `Week of ${e.label}`);

  return shell('Home', `<header><h1>Home</h1><p>${esc(shortDate(d.today))}</p>${topNav('/home')}</header>
${commitments}
${follow}
<section><h2>Latest</h2>${latest ? `<ul class="list">${latest}</ul>` : '<p class="muted">Nothing yet.</p>'}</section>
<section><h2>Decisions coming up</h2>${upcoming ? `<ul class="list">${upcoming}</ul>` : '<p class="muted">No open decisions ahead.</p>'}
<p class="note"><a href="/decisions">All decisions${d.openDecisions ? ` (${d.openDecisions} open)` : ''}</a> · <a href="/decisions/new">Add one</a></p></section>
<section><h2>Archive</h2>${archive || '<p class="muted">Nothing yet.</p>'}</section>
${signOut(email)}`);
}

export function renderDecisions(list, { email, today }) {
  const item = (x) => `<li><div class="row"><span>${esc(x.title)}${x.status === 'open' && x.date < today ? ' <span class="badge miss">Past its date</span>' : ''}${x.status === 'dropped' ? ' <span class="badge">Dropped</span>' : ''}</span><span class="muted">${esc(shortDate(x.date))}</span></div>
    <p class="d-q">${esc(x.question)}</p>${x.outcome ? `<p class="d-out"><strong>Decided:</strong> ${esc(x.outcome)}</p>` : ''}
    <p class="note">${x.briefHref ? `<a href="${esc(x.briefHref)}">Read the brief</a> · ` : ''}<a href="/decisions/${esc(x.id)}">${x.status === 'open' ? 'Edit or record the outcome' : 'Edit'}</a></p></li>`;
  const open = list.filter((x) => x.status === 'open');
  const closed = list.filter((x) => x.status !== 'open').reverse();
  return shell('Decisions', `<header><h1>Decisions</h1><p>Each open one gets an evidence brief the Wednesday before its date.</p>${topNav('/decisions')}</header>
<section><h2>Open</h2>${open.length ? `<ul class="list">${open.map(item).join('')}</ul>` : '<p class="muted">No open decisions.</p>'}
<p style="margin:14px 0 0"><a class="btn" href="/decisions/new">Add a decision</a></p></section>
${closed.length ? `<section><h2>Decided</h2><ul class="list">${closed.map(item).join('')}</ul></section>` : ''}
${signOut(email)}`);
}

export function renderDecisionForm(entry, { email, csrf, isNew, error }) {
  const v = entry ?? { status: 'open', options: [] };
  const field = (label, control, hint = '') => `<label class="field"><span>${label}</span>${control}${hint ? `<small>${hint}</small>` : ''}</label>`;
  const status = ['open', 'decided', 'dropped'].map((x) => `<option value="${x}"${v.status === x ? ' selected' : ''}>${x[0].toUpperCase()}${x.slice(1)}</option>`).join('');
  return shell(isNew ? 'Add a decision' : 'Edit decision', `<header><h1>${isNew ? 'Add a decision' : 'Edit decision'}</h1>${topNav('')}</header>
<section><form method="post" action="/decisions/${isNew ? 'new' : esc(v.id)}">
<input type="hidden" name="csrf" value="${esc(csrf)}">
${error ? `<p class="error">Not saved: ${esc(error)}</p>` : ''}
${field('Title', `<input name="title" maxlength="120" required value="${esc(v.title)}">`)}
${field('Date', `<input name="date" type="date" required value="${esc(v.date)}">`, 'The day you decide. The brief arrives the Wednesday before.')}
${field('Question', `<textarea name="question" maxlength="400" required>${esc(v.question)}</textarea>`)}
${field('Options', `<textarea name="options">${esc((v.options ?? []).join('\n'))}</textarea>`, 'One per line, up to six. Optional.')}
${field('Context', `<textarea name="context" maxlength="2000" style="min-height:160px">${esc(v.context)}</textarea>`, 'The plan, targets and criteria the brief should judge against. Stays on this site.')}
${field('Status', `<select name="status">${status}</select>`)}
${field('Outcome', `<textarea name="outcome" maxlength="600">${esc(v.outcome)}</textarea>`, 'What you decided, once you have.')}
<div class="actions"><button class="btn" type="submit">Save</button><a href="/decisions">Cancel</a></div>
</form></section>
${signOut(email)}`);
}

const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${SUMMARY_CSS}</style></head><body><main>
${body}
</main></body></html>`;

const signOut = (email) => `<footer><form class="signout" method="post" action="/summaries/logout"><span>${esc(email)}</span><button type="submit">Sign out</button></form></footer>`;

export function renderSummariesLogin({ clientId, loginUri }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Claude Code summaries</title><style>${SUMMARY_CSS}</style>
<script src="https://accounts.google.com/gsi/client" async></script></head><body><main>
<header><h1>Claude Code summaries</h1><p>Sign in to read them.</p></header>
<section>
<div id="g_id_onload" data-client_id="${esc(clientId)}" data-login_uri="${esc(loginUri)}" data-ux_mode="popup" data-auto_prompt="false" data-itp_support="true"></div>
<div class="gsi"><div class="g_id_signin" data-type="standard" data-theme="outline" data-size="large" data-text="signin_with" data-shape="pill"></div></div>
</section>
</main></body></html>`;
}

export function renderSummariesDenied() {
  return shell('Not allowed', `<header><h1>Not allowed</h1></header><section><p>This account can't view summaries.</p><p><a href="/summaries/login">Try another account</a></p></section>`);
}

export function renderSummariesList(entries, { email } = {}) {
  const rows = entries.map((e) => `<li><a href="${esc(e.href)}">Week of ${esc(e.label)}</a></li>`).join('');
  return shell('Claude Code summaries', `<header><h1>Claude Code summaries</h1><p>What you built each week</p>${topNav('/summaries')}</header>
<section>${rows ? `<ul class="list">${rows}</ul>` : '<p class="muted">No summaries yet.</p>'}</section>
${signOut(email)}`);
}

export function renderSummary({ week, note, newer, older, email }) {
  const generated = new Date(note.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
  const nav = `<nav class="nav"><span>${older ? `<a href="${esc(older.href)}">← ${esc(older.label)}</a>` : ''}</span><a href="/summaries">All weeks</a><span>${newer ? `<a href="${esc(newer.href)}">${esc(newer.label)} →</a>` : ''}</span></nav>`;
  return shell(`Claude Code · ${weekLabel(week)}`, `<header><h1>Week of ${esc(weekLabel(week))}</h1><p>Claude Code summary · generated ${esc(generated)}</p></header>
${nav}
<div class="narrative">${paragraphs(note.text)}</div>
${nav}
${signOut(email)}`);
}
