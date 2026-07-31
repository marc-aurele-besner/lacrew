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

/** Wall-clock fields of an instant in one IANA zone. */
export type ZonedParts = {
  minute: number;
  hour: number;
  day: number;
  month: number;
  /** 0 = Sunday, matching cron's day-of-week field. */
  weekday: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** True when the runtime recognises this IANA zone name. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wall-clock fields for `date` as read in `timeZone`.
 *
 * Via `Intl` rather than an offset table, so daylight saving is the platform's
 * problem rather than ours. A schedule an operator wrote as "09:00" means
 * 09:00 where they are, on both sides of a clock change — an implementation
 * that stored a fixed offset would drift by an hour twice a year and look like
 * a scheduler bug rather than the timezone bug it is.
 */
export function zonedParts(date: Date, timeZone = "UTC"): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);
  const read = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // "24" is what hour12:false reports for midnight in some ICU versions; cron
  // has no hour 24, and reading it as one would make an `0 0 * * *` heartbeat
  // silently never fire.
  const hour = Number(read("hour")) % 24;
  return {
    minute: Number(read("minute")),
    hour,
    day: Number(read("day")),
    month: Number(read("month")),
    weekday: Math.max(0, WEEKDAYS.indexOf(read("weekday"))),
  };
}

/**
 * Whether the expression matches `date` as read in `timeZone` (minute
 * resolution). `cronMatches` is this with the zone fixed to UTC — flow
 * schedules are declared in UTC, and only surfaces that let an operator pick a
 * zone (crew heartbeats) need this one.
 */
export function cronMatchesInZone(expr: string, date: Date, timeZone = "UTC"): boolean {
  const sets = parseCron(expr);
  if (!sets) return false;
  const [minute, hour, dom, month, dow] = sets;
  const at = zonedParts(date, timeZone);
  return (
    minute!.has(at.minute) &&
    hour!.has(at.hour) &&
    dom!.has(at.day) &&
    month!.has(at.month) &&
    dow!.has(at.weekday)
  );
}

/**
 * Smallest gap in minutes the expression's minute field can produce, or null
 * when it does not parse.
 *
 * Only the minute field is read, and that is exact for the purpose: every
 * other field can make a schedule sparser, never denser. A caller enforcing a
 * cadence floor gets an answer it can rely on rather than a general period
 * analysis that would have to be approximate.
 */
export function cronMinuteGap(expr: string): number | null {
  const sets = parseCron(expr);
  if (!sets) return null;
  const minutes = [...sets[0]!].sort((a, b) => a - b);
  if (minutes.length === 0) return null;
  // A single firing minute repeats once an hour — but only if every coarser
  // field admits consecutive hours, which is the densest case and the one a
  // floor has to be checked against.
  if (minutes.length === 1) return 60;
  let gap = 60 - minutes[minutes.length - 1]! + minutes[0]!;
  for (let i = 1; i < minutes.length; i += 1) {
    gap = Math.min(gap, minutes[i]! - minutes[i - 1]!);
  }
  return gap;
}
