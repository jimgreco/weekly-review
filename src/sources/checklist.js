// Ritual Cue (DB daily_checklist). All state is one JSONB document in
// daily_app_state (id = 1). A day's outcome for an item follows the server's
// reconciledLegacyDayState: the authoritative occurrence for that scheduled
// date (highest scheduleRevision, then newest stamp, then deviceID, then
// occurrence id) overrides the legacy completions map.
//
// The item's schedule rules (weekdays, monthly ordinals, pause windows) live
// in the Swift app, so this module reports what was done and what was marked
// missed rather than a due-vs-done rate.

function revision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function stampWins(incoming, current) {
  if (!current) return true;
  if (incoming.stamp !== current.stamp) return incoming.stamp > current.stamp;
  return (incoming.deviceID ?? '') > (current.deviceID ?? '');
}

export function outcomesByDate(record) {
  const winners = new Map();
  for (const [occurrenceID, state] of Object.entries(record.occurrences ?? {})) {
    const date = state?.value?.scheduledDate;
    if (!date || !state.value.outcome) continue;
    const current = winners.get(date);
    const inRev = revision(state.value.scheduleRevision);
    const curRev = revision(current?.state.value.scheduleRevision);
    let wins = !current || inRev > curRev;
    if (current && inRev === curRev) {
      wins = stampWins(state, current.state)
        || (!stampWins(current.state, state) && occurrenceID > current.occurrenceID);
    }
    if (wins) winners.set(date, { occurrenceID, state });
  }
  const outcomes = {};
  for (const [date, entry] of Object.entries(record.completions ?? {})) {
    if (entry?.value) outcomes[date] = 'done';
  }
  for (const [date, { state }] of winners) outcomes[date] = state.value.outcome;
  return outcomes;
}

function field(record, name) {
  return record.fields?.[name]?.value ?? null;
}

function countIn(outcomes, week, kind) {
  return week.days.filter((d) => outcomes[d] === kind).length;
}

export function summarizeChecklist(items, groups, week, prev) {
  const rows = [];
  for (const record of Object.values(items ?? {})) {
    if (record.deleted) continue;
    const endedAt = field(record, 'endedAt');
    if (endedAt && String(endedAt).slice(0, 10) < prev.start) continue;
    const outcomes = outcomesByDate(record);
    const groupId = field(record, 'groupID');
    rows.push({
      title: field(record, 'title') || 'Untitled',
      group: groupId ? groups?.[groupId]?.fields?.name?.value ?? null : null,
      done: countIn(outcomes, week, 'done'),
      missed: countIn(outcomes, week, 'missed'),
      skipped: countIn(outcomes, week, 'skipped'),
      donePrev: countIn(outcomes, prev, 'done'),
    });
  }
  const active = rows.filter((r) => r.done + r.missed + r.skipped + r.donePrev > 0);
  const totals = (key) => active.reduce((n, r) => n + r[key], 0);
  return {
    trackedItems: active.length,
    doneCount: totals('done'),
    doneCountPrev: totals('donePrev'),
    missedCount: totals('missed'),
    perDayDone: week.days.map((d) => ({
      date: d,
      done: Object.values(items ?? {}).filter((r) => !r.deleted && outcomesByDate(r)[d] === 'done').length,
    })),
    mostConsistent: [...active].sort((a, b) => b.done - a.done).filter((r) => r.done > 0).slice(0, 4),
    // Done last week, not at all this week: the things quietly falling off.
    slipping: active.filter((r) => r.donePrev >= 2 && r.done === 0).map((r) => r.title),
    mostMissed: active.filter((r) => r.missed > 0).sort((a, b) => b.missed - a.missed).slice(0, 3),
  };
}

export async function collectChecklist(db, { email, week, prev }) {
  const user = await db.query(
    `SELECT u.key AS id FROM daily_app_state, jsonb_each(data->'users') u
      WHERE daily_app_state.id = 1 AND lower(u.value->>'email') = lower($1) LIMIT 1`,
    [email],
  );
  const userId = user.rows[0]?.id;
  if (!userId) return { status: 'no-account' };
  const { rows } = await db.query(
    `SELECT data->'accounts'->$1->'items' AS items, data->'accounts'->$1->'groups' AS groups
       FROM daily_app_state WHERE id = 1`,
    [userId],
  );
  return { status: 'ok', ...summarizeChecklist(rows[0]?.items, rows[0]?.groups, week, prev) };
}
