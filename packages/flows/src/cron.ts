// Minimal 5-field cron matcher (minute hour dom month dow, UTC) for flow
// schedules. Supports "*", "*/n", "a", "a-b", "a-b/n" and comma lists; dow
// accepts 0-7 with 7 = Sunday. Minute resolution — the orchestrator's flow
// scheduler fires a matching flow at most once per matching minute.

type FieldRange = { min: number; max: number };

const FIELDS: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (7 → 0)
];

function parseField(raw: string, range: FieldRange): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const [body, stepRaw] = part.split("/");
    if (!body || (stepRaw !== undefined && !/^\d+$/.test(stepRaw))) return null;
    const step = stepRaw ? Number(stepRaw) : 1;
    if (step < 1) return null;

    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = range.min;
      hi = range.max;
    } else if (/^\d+$/.test(body)) {
      lo = Number(body);
      hi = stepRaw ? range.max : lo;
    } else {
      const m = body.match(/^(\d+)-(\d+)$/);
      if (!m) return null;
      lo = Number(m[1]);
      hi = Number(m[2]);
    }
    if (lo < range.min || hi > range.max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && range.max === 7 ? 0 : v);
  }
  return out;
}

/** Parse all five fields; null when the expression is malformed. */
export function parseCron(expr: string): Set<number>[] | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const set = parseField(parts[i]!, FIELDS[i]!);
    if (!set) return null;
    sets.push(set);
  }
  return sets;
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

/** Whether the expression matches the given time (UTC, minute resolution). */
export function cronMatches(expr: string, date: Date): boolean {
  const sets = parseCron(expr);
  if (!sets) return false;
  const [minute, hour, dom, month, dow] = sets;
  return (
    minute!.has(date.getUTCMinutes()) &&
    hour!.has(date.getUTCHours()) &&
    dom!.has(date.getUTCDate()) &&
    month!.has(date.getUTCMonth() + 1) &&
    dow!.has(date.getUTCDay())
  );
}
