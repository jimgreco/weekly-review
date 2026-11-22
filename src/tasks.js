// The link to Task Sidekick (jimgreco/reminders-ai), which turns accepted
// commitments into reminders on the owner's iPhone.
//
// - `sync(record)` sends the accepted commitments for a week every time that
//   week's record changes (a decision on the page, a re-publish, a score).
//   Once a week is scored it sends none, and Task Sidekick removes the
//   reminders that are still open.
// - `checks(week)` reads back which commitments have a reminder and which are
//   checked off, for the routine that scores them.
//
// Both are best effort: the review site works the same with Task Sidekick
// down or unconfigured (TASKS_API_URL and TASKS_COMMITMENTS_TOKEN unset).
const RETRY_DELAYS_MS = [2_000, 15_000, 60_000];

/** What Task Sidekick should hold for a week: the accepted items, none once scored. */
export function acceptedFor(record) {
  if (!record || record.scoredAt) return [];
  return record.items.filter((c) => c.decision === 'accepted')
    .map(({ id, text, measure, area }) => ({ id, text, measure: measure ?? null, area: area ?? 'other' }));
}

export function createTasksLink(config, { fetchImpl = fetch, log = console, retryDelaysMs = RETRY_DELAYS_MS, timeoutMs = 8_000 } = {}) {
  const base = config.tasksUrl;
  const token = config.tasksToken;
  const enabled = Boolean(base && token);
  const endpoint = (week) => `${base}/api/commitments?week=${encodeURIComponent(week)}`;
  const request = (week, init = {}) => fetchImpl(endpoint(week), {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.headers ?? {}) },
    redirect: 'error', // never forward the token somewhere else
    signal: AbortSignal.timeout(timeoutMs),
  });

  // The newest record per week waiting to be sent. One send at a time, and a
  // send always takes the newest record, so a slow or retried request can't
  // overwrite a later decision with an earlier one.
  const waiting = new Map();
  let queue = Promise.resolve();

  async function send(week) {
    for (let attempt = 0; ; attempt += 1) {
      const record = waiting.get(week);
      if (!record) return; // a later send already took it
      waiting.delete(week);
      try {
        const response = await request(week, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: acceptedFor(record) }),
        });
        // 4xx will not get better by trying again (404: the link is off on the other side).
        if (response.ok || (response.status >= 400 && response.status < 500)) {
          if (!response.ok) log.error(`[tasks] commitments for ${week} not accepted: HTTP ${response.status}`);
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (!waiting.has(week)) waiting.set(week, record); // keep it for the retry unless a newer one arrived
        if (attempt >= retryDelaysMs.length) {
          waiting.delete(week);
          log.error(`[tasks] gave up sending commitments for ${week}: ${error.message}`);
          return;
        }
        await new Promise((resolve) => { setTimeout(resolve, retryDelaysMs[attempt]); });
      }
    }
  }

  return {
    enabled,

    /** Send a week's commitments in the background. Never throws; returns when sent or given up. */
    sync(record) {
      if (!enabled || !record?.week) return Promise.resolve();
      waiting.set(record.week, record);
      const run = queue.then(() => send(record.week));
      queue = run.catch(() => {});
      return queue;
    },

    /** id → {reminder, done, completedAt} for a week, or null when it can't be read. */
    async checks(week) {
      if (!enabled) return null;
      try {
        const response = await request(week);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (body?.week !== week || !Array.isArray(body.items)) throw new Error('unexpected response shape');
        return new Map(body.items.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, {
          reminder: c.reminder === true,
          done: c.done === true,
          completedAt: typeof c.completedAt === 'string' ? c.completedAt : null,
        }]));
      } catch (error) {
        log.error(`[tasks] could not read check-offs for ${week}: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`);
        return null;
      }
    },
  };
}

/**
 * Adds to each of a week's items (as the routine sees them, forRoutine) what
 * the owner did with its reminder: `checkedOff` is true or false when a
 * reminder exists, and null when there is none or it can't be read.
 */
export function withChecks(due, checks) {
  if (!due) return due;
  return {
    ...due,
    items: due.items.map((item) => {
      const check = checks?.get(item.id);
      return { ...item, checkedOff: check?.reminder ? check.done : null, checkedOffAt: check?.reminder && check.done ? check.completedAt : null };
    }),
  };
}
