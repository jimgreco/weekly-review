// Rep, Mix, Burn (DynamoDB single table). Read-only by construction: this
// module only ever issues GetItem and Query. DynamoDB-local has no IAM, so
// nothing on the database side enforces that.
import { createHash } from 'node:crypto';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { round, delta } from '../stats.js';

function emailKey(email) {
  return `EMAIL#${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
}

async function queryAll(doc, params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await doc.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

function isWorkingSet(set) {
  if (set.setType === 'warmup') return false;
  if (set.completion) return set.completion === 'recorded';
  // Older logs predate the completion field: count sets that have reps.
  return Boolean(set.reps || set.repsLeft || set.repsRight);
}

export function summarizeSessions(logs, exercises, week) {
  const inWeek = logs.filter((l) => l.date >= week.start && l.date <= week.end);
  const finished = inWeek.filter((l) => l.status === 'finished')
    .sort((a, b) => a.date.localeCompare(b.date));
  const setsByGroup = {};
  let workingSets = 0;
  let pbCount = 0;

  const sessions = finished.map((log) => {
    let sessionSets = 0;
    for (const item of log.exerciseItems ?? []) {
      const n = (item.sets ?? []).filter(isWorkingSet).length;
      sessionSets += n;
      const group = exercises[item.exerciseId]?.muscleGroup || 'Other';
      setsByGroup[group] = (setsByGroup[group] ?? 0) + n;
    }
    workingSets += sessionSets;
    const pbs = log.pbExerciseIds?.length ?? (log.hasPB ? 1 : 0);
    pbCount += pbs;
    let minutes = null;
    if (log.startTime && log.endTime) {
      const ms = Date.parse(log.endTime) - Date.parse(log.startTime) - (log.pausedDurationMs ?? 0);
      if (ms > 0 && ms < 6 * 3600e3) minutes = round(ms / 60000);
    }
    return {
      date: log.date,
      name: log.name || log.prescription?.templateName || 'Workout',
      workingSets: sessionSets,
      minutes,
      readiness: log.readiness ?? null,
      personalBests: (log.pbExerciseIds ?? []).map((id) => exercises[id]?.name).filter(Boolean),
      optional: Boolean(log.prescription?.optional),
    };
  });

  return {
    sessions,
    sessionCount: sessions.length,
    skippedCount: inWeek.filter((l) => l.status === 'skipped').length,
    workingSets,
    personalBestCount: pbCount,
    setsByMuscleGroup: Object.fromEntries(
      Object.entries(setsByGroup).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]),
    ),
  };
}

function activeProgram(programs, week) {
  const program = programs.find((p) => p.active) ?? null;
  if (!program) return null;
  const phase = (program.phases ?? []).find(
    (ph) => ph.startDate <= week.end && (!ph.endDate || ph.endDate >= week.start),
  );
  return { name: program.name, phase: phase?.name ?? null };
}

export async function collectWorkouts(doc, { email, table, week, prev }) {
  const alias = await doc.send(new GetCommand({ TableName: table, Key: { PK: emailKey(email), SK: 'ALIAS' } }));
  const sub = alias.Item?.accountSub;
  if (!sub) return { status: 'no-account' };
  const pk = `USER#${sub}`;
  const account = await doc.send(new GetCommand({ TableName: table, Key: { PK: pk, SK: 'ACCOUNT' } }));
  if (account.Item?.deletedAt) return { status: 'no-account' };

  const byPrefix = (prefix, extra = {}) => queryAll(doc, {
    TableName: table,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
    ...extra,
    ExpressionAttributeValues: { ':pk': pk, ':p': prefix, ...(extra.ExpressionAttributeValues ?? {}) },
  });

  const [logs, exerciseItems, programs] = await Promise.all([
    byPrefix('LOG#', {
      FilterExpression: '#d BETWEEN :s AND :e',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':s': prev.start, ':e': week.end },
    }),
    byPrefix('EXERCISE#'),
    byPrefix('PROGRAM#'),
  ]);
  const exercises = Object.fromEntries(exerciseItems.map((e) => [e.id, { name: e.name, muscleGroup: e.muscleGroup }]));
  const current = summarizeSessions(logs, exercises, week);
  const previous = summarizeSessions(logs, exercises, prev);
  return {
    status: 'ok',
    program: activeProgram(programs, week),
    current,
    previous: { sessionCount: previous.sessionCount, workingSets: previous.workingSets, setsByMuscleGroup: previous.setsByMuscleGroup },
    change: {
      sessionCount: delta(current.sessionCount, previous.sessionCount),
      workingSets: delta(current.workingSets, previous.workingSets),
    },
  };
}

export { emailKey as _emailKey };
