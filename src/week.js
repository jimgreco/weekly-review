// Calendar-week math on plain YYYY-MM-DD strings. Weeks run Monday–Sunday.

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function localDate(instant, timezone) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

export function localParts(instant, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23',
    }).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: localDate(instant, timezone), weekday, hour: Number(parts.hour) };
}

export function mondayOf(isoDate) {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(isoDate, -((dow + 6) % 7));
}

export function weekRange(monday) {
  if (mondayOf(monday) !== monday) throw new Error(`${monday} is not a Monday`);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return { start: monday, end: days[6], days };
}

/** The week a review sent at `instant` covers: the Monday–Sunday containing it. */
export function currentWeek(instant, timezone) {
  return weekRange(mondayOf(localDate(instant, timezone)));
}

export function previousWeek(week) {
  return weekRange(addDays(week.start, -7));
}

export function nextWeek(week) {
  return weekRange(addDays(week.start, 7));
}

/**
 * A calendar month as whole weeks: the Monday-Sunday weeks that END in it, so
 * every one is finished once the month is. Returns {key, label, weeks} with
 * `weeks` as Mondays, oldest first.
 */
export function monthWeeks(key) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw new Error(`${key} is not a month (YYYY-MM)`);
  const weeks = [];
  for (let day = `${key}-01`; day.slice(0, 7) === key; day = addDays(day, 1)) {
    if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) weeks.push(addDays(day, -6));
  }
  const label = new Date(`${key}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { key, label, weeks };
}

export function previousMonth(key) {
  return addDays(`${key}-01`, -1).slice(0, 7);
}
