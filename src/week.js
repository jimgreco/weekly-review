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
