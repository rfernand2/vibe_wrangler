'use strict';

/**
 * Shapes graded tasks into the agent performance chart's series.
 *
 * A point is one agent's average grade over one time period, not one run: a busy Tuesday reads
 * as a single dot rather than a spike of five. Periods are days until the history outgrows
 * CHART_DAY_LIMIT, after which they become weeks so the axis never smears. A period an agent
 * was not used in gets no point at all, and each series is cut into segments of consecutive
 * periods so the line breaks over the gap instead of bridging it.
 */

const GRADE_SCALE = ['F', 'D-', 'D', 'D+', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+'];
const CHART_DAY_LIMIT = 50;
const DAY_MS = 86400000;

/** SQLite hands back naive UTC ("2026-08-09 14:03:11"), so pin the zone before parsing. */
function gradedDate(ts) {
  if (!ts) return null;
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
}

/** Days since the epoch in the reader's own zone, so a run lands on the day they watched it finish. */
function dayNumber(date) {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function dayNumberToDate(day) {
  const utc = new Date(day * DAY_MS);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

/** Grades average on their own scale, so B+ and A- meet halfway rather than at some numeric fiction. */
function averageGrade(grades) {
  const total = grades.reduce((sum, grade) => sum + GRADE_SCALE.indexOf(grade), 0);
  return total / grades.length;
}

function lineSegments(points) {
  const segments = [];
  for (const point of points) {
    const open = segments[segments.length - 1];
    if (open && point.period === open[open.length - 1].period + 1) open.push(point);
    else segments.push([point]);
  }
  return segments;
}

/**
 * @param rows    graded tasks, as /api/performance returns them
 * @param labelOf names the series a row belongs to; defaults to the model that earned the grade
 */
function performanceSeries(rows, labelOf = (row) => row.model) {
  const graded = (rows || [])
    .map((row) => ({ row, date: gradedDate(row.graded_at) }))
    .filter((entry) => entry.date && GRADE_SCALE.includes(entry.row.grade))
    .map((entry) => ({ ...entry, day: dayNumber(entry.date) }));
  if (!graded.length) return { bucket: 'day', periodDays: 1, periods: [], series: [] };

  const firstDay = Math.min(...graded.map((entry) => entry.day));
  const lastDay = Math.max(...graded.map((entry) => entry.day));
  const weekly = lastDay - firstDay + 1 > CHART_DAY_LIMIT;
  const periodDays = weekly ? 7 : 1;
  const periodOf = (day) => Math.floor((day - firstDay) / periodDays);

  // Every period across the whole span, used or not, so unused ones still take up their width.
  const periods = [];
  for (let index = 0; index <= periodOf(lastDay); index++) {
    const day = firstDay + index * periodDays;
    periods.push({ index, day, date: dayNumberToDate(day) });
  }

  const byLabel = new Map();
  for (const entry of graded) {
    const label = labelOf(entry.row);
    if (!byLabel.has(label)) byLabel.set(label, new Map());
    const buckets = byLabel.get(label);
    const period = periodOf(entry.day);
    if (!buckets.has(period)) buckets.set(period, []);
    buckets.get(period).push(entry.row);
  }

  const series = [...byLabel.entries()].map(([label, buckets]) => {
    const points = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([period, periodRows]) => {
        const value = averageGrade(periodRows.map((row) => row.grade));
        return {
          period,
          value,
          grade: GRADE_SCALE[Math.round(value)],
          count: periodRows.length,
          rows: periodRows,
        };
      });
    return { label, points, segments: lineSegments(points) };
  });

  return { bucket: weekly ? 'week' : 'day', periodDays, periods, series };
}

if (typeof module !== 'undefined') {
  module.exports = {
    GRADE_SCALE,
    CHART_DAY_LIMIT,
    gradedDate,
    dayNumber,
    dayNumberToDate,
    averageGrade,
    lineSegments,
    performanceSeries,
  };
}
