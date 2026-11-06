// Week of Us (DB common_week). Calendar events are fetched live from Google
// by the planner and never stored, so this reads only planning items
// (tasks), the household's weekly_reviews notes, and deadlines.
//
// Open tasks are moved forward by carry_over_open_tasks(), so a task's
// week_start_date is where it is now; original_week_start_date and
// carryover_count say how long it has been slipping.

async function household(db, email) {
  const { rows } = await db.query(
    `SELECT h.id, h.name, h.timezone
       FROM users u
       JOIN household_members m ON m.user_id = u.id
       JOIN households h ON h.id = m.household_id
      WHERE u.email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

const TASK_COLUMNS = `
  p.id, p.text, p.is_completed, to_char(p.planning_date, 'YYYY-MM-DD') AS planning_date,
  to_char(p.week_start_date, 'YYYY-MM-DD') AS week_start_date,
  to_char(p.deadline, 'YYYY-MM-DD') AS deadline, p.carryover_count, p.is_backlog,
  COALESCE(ru.display_name, rc.name) AS responsible`;

const TASK_JOINS = `
  LEFT JOIN users ru ON ru.id = p.responsible_member_id
  LEFT JOIN child_profiles rc ON rc.id = p.responsible_member_id`;

export async function collectPlanner(db, { email, week, next }) {
  const hh = await household(db, email);
  if (!hh) return { status: 'no-account' };

  const thisWeek = await db.query(
    `SELECT ${TASK_COLUMNS} FROM planning_items p ${TASK_JOINS}
      WHERE p.household_id = $1 AND p.type = 'task' AND NOT p.is_backlog
        AND p.week_start_date = $2::date
      ORDER BY p.planning_date NULLS LAST, p.sort_order`,
    [hh.id, week.start],
  );
  const upcoming = await db.query(
    `SELECT ${TASK_COLUMNS} FROM planning_items p ${TASK_JOINS}
      WHERE p.household_id = $1 AND p.type = 'task' AND NOT p.is_completed
        AND (p.week_start_date = $2::date OR p.deadline BETWEEN $2::date AND $3::date)
      ORDER BY p.deadline NULLS LAST, p.planning_date NULLS LAST, p.sort_order
      LIMIT 25`,
    [hh.id, next.start, next.end],
  );
  const overdue = await db.query(
    `SELECT ${TASK_COLUMNS} FROM planning_items p ${TASK_JOINS}
      WHERE p.household_id = $1 AND p.type = 'task' AND NOT p.is_completed
        AND p.deadline < $2::date
      ORDER BY p.deadline LIMIT 10`,
    [hh.id, next.start],
  );
  const notes = await db.query(
    `SELECT to_char(week_start_date, 'YYYY-MM-DD') AS week_start_date, priorities, meals, logistics
       FROM weekly_reviews WHERE household_id = $1 AND week_start_date IN ($2::date, $3::date)`,
    [hh.id, week.start, next.start],
  );

  const tasks = thisWeek.rows;
  const done = tasks.filter((t) => t.is_completed);
  const open = tasks.filter((t) => !t.is_completed);
  const brief = (t) => ({
    text: t.text, responsible: t.responsible ?? null, deadline: t.deadline,
    date: t.planning_date, carryovers: t.carryover_count ?? 0,
  });
  const notesFor = (start) => {
    const n = notes.rows.find((r) => r.week_start_date === start);
    return n ? { priorities: n.priorities || null, meals: n.meals || null, logistics: n.logistics || null } : null;
  };

  return {
    status: 'ok',
    household: hh.name,
    current: {
      taskCount: tasks.length,
      doneCount: done.length,
      openCount: open.length,
      done: done.map(brief).slice(0, 12),
      // Open tasks that have already been carried over at least twice.
      stuck: open.filter((t) => (t.carryover_count ?? 0) >= 2).map(brief).slice(0, 6),
      notes: notesFor(week.start),
    },
    nextWeek: {
      tasks: upcoming.rows.map(brief),
      notes: notesFor(next.start),
    },
    overdue: overdue.rows.map(brief),
  };
}
