/**
 * One org's epoch cadence: the cron its scheduled epoch runs on, and when the
 * next one is due.
 *
 * A process serving many orgs has one recurring tick, not one schedule per
 * org. The tick decides nothing about cadence: for each org it asks whether
 * that org's epoch is due, and the answer is read on the org's own clock. A
 * sandbox org's clock includes the time it has skipped, so an org moved
 * forward past its next epoch is due at once, whatever the wall clock says.
 *
 * The due time is kept twice. `nextAt` is the truth, on the org's clock.
 * `dueAt` is the same moment on the wall clock (`nextAt` less the skipped
 * time), which is all a tick needs to pass over an org without loading it.
 */

import { nextCronAfter } from "@lacrew/flows";

/** The cadence of an org that has set none, when the operator has set none either. */
export const DEFAULT_EPOCH_CRON = "0 * * * *";

/** An org's cadence as stored: ISO times, null until first worked out. */
export interface EpochScheduleRow {
  /** The org's own cron; null when it runs on the default. */
  cron: string | null;
  nextAt: string | null;
  dueAt: string | null;
}

export interface EpochScheduleStore {
  /** Null when the org is not registered. */
  read(): Promise<EpochScheduleRow | null>;
  /**
   * Write the cadence; `cron` is left as it is when not given. With
   * `ifNextAt`, only while the stored `nextAt` is still that value. False when
   * nothing was written.
   */
  write(
    change: { cron?: string | null; nextAt: string | null; dueAt: string | null },
    ifNextAt?: string | null,
  ): Promise<boolean>;
}

/** What a caller is told about when the next scheduled epoch runs. */
export interface EpochCadenceStatus {
  /** The cron in effect (or `interval:<ms>` for a process-wide dev loop); null when none is scheduled. */
  schedule: string | null;
  /**
   * Whose schedule it is: `org` (this org set it), `default` (the operator's,
   * for an org that set none) or `process` (one schedule for the whole
   * orchestrator, which runs a single org).
   */
  source: "org" | "default" | "process";
  /**
   * The clock `nextAt` is read on. `org`: the org's own, which a sandbox can
   * skip forward, and skipping past `nextAt` runs the epoch. `wall`: real
   * time, which nothing skips.
   */
  clock: "org" | "wall";
  /** Unix seconds of the next scheduled epoch on that clock; null when it cannot be told. */
  nextAt: number | null;
  nextAtIso: string | null;
  /** Seconds from now, on that clock, until the next scheduled epoch. */
  secondsUntilNext: number | null;
}

export interface EpochCadence {
  status(): Promise<EpochCadenceStatus>;
  /**
   * Set the org's own cron, or null to go back to the default. The next epoch
   * is the first match after now on the org's clock. Throws
   * `InvalidEpochCronError` for an expression that does not parse or never fires.
   */
  setSchedule(cron: string | null): Promise<EpochCadenceStatus>;
  /**
   * Run the scheduled epoch if it is due on the org's clock, once, and move
   * the due time on to the next match. Several periods skipped at once are one
   * epoch, as a cron that was down for them would run one.
   */
  runIfDue(): Promise<{ ran: boolean }>;
  /**
   * The org's clock was moved. `advanced`: the epoch runs now if the clock
   * passed it. `reset`: the clock is back on wall time, and the next epoch is
   * worked out again from there.
   */
  clockMoved(how: "advanced" | "reset"): Promise<{ ran: boolean }>;
}

export class InvalidEpochCronError extends Error {
  constructor() {
    super("invalid_cron");
    this.name = "InvalidEpochCronError";
  }
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const secondsOf = (isoTime: string): number => Math.floor(Date.parse(isoTime) / 1000);

export function normalizeCron(expr: string): string {
  return expr.trim().replace(/\s+/g, " ");
}

export function createEpochCadence(options: {
  store: EpochScheduleStore;
  /** The cron of an org that has set none. */
  defaultCron: string;
  /** The org's clock, unix seconds. */
  now: () => number;
  /** Seconds the org's clock runs ahead of the wall clock. */
  offset: () => number;
  /** The scheduled epoch itself. */
  run: () => Promise<unknown>;
}): EpochCadence {
  const { store, now, offset, run } = options;
  const fallback = normalizeCron(options.defaultCron);
  // An operator default that never fires would leave every org without an epoch.
  const defaultCron = nextCronAfter(fallback, new Date()) ? fallback : DEFAULT_EPOCH_CRON;

  /** The first match after now on the org's clock, as it is stored. */
  function nextFor(cron: string): { nextAt: string; dueAt: string } {
    const at = nextCronAfter(cron, new Date(now() * 1000));
    if (!at) throw new InvalidEpochCronError();
    const seconds = Math.floor(at.getTime() / 1000);
    return { nextAt: iso(seconds), dueAt: iso(seconds - offset()) };
  }

  function describe(row: EpochScheduleRow, nextAt: string): EpochCadenceStatus {
    const seconds = secondsOf(nextAt);
    return {
      schedule: row.cron ?? defaultCron,
      source: row.cron ? "org" : "default",
      clock: "org",
      nextAt: seconds,
      nextAtIso: iso(seconds),
      secondsUntilNext: Math.max(seconds - now(), 0),
    };
  }

  async function status(): Promise<EpochCadenceStatus> {
    const row = (await store.read()) ?? { cron: null, nextAt: null, dueAt: null };
    if (row.nextAt) return describe(row, row.nextAt);
    // Never worked out: do it now, unless somebody else just did.
    const next = nextFor(row.cron ?? defaultCron);
    if (await store.write(next, null)) return describe(row, next.nextAt);
    const again = await store.read();
    return describe(again ?? row, again?.nextAt ?? next.nextAt);
  }

  async function runIfDue(): Promise<{ ran: boolean }> {
    const row = await store.read();
    if (!row) return { ran: false };
    const cron = row.cron ?? defaultCron;
    if (!row.nextAt) {
      await store.write(nextFor(cron), null);
      return { ran: false };
    }
    const nextAt = secondsOf(row.nextAt);
    if (now() < nextAt) {
      // Not due. If the wall-clock copy says otherwise the org's clock moved
      // since it was written; correct it, or every tick would wake this org.
      const dueAt = iso(nextAt - offset());
      if (dueAt !== row.dueAt) await store.write({ nextAt: row.nextAt, dueAt }, row.nextAt);
      return { ran: false };
    }
    // Claimed before it is run: of any number of callers that saw this epoch
    // due, one moves the due time on, and only that one runs it.
    if (!(await store.write(nextFor(cron), row.nextAt))) return { ran: false };
    try {
      await run();
    } catch (err) {
      console.error("[@lacrew/orchestrator] scheduled epoch failed:", err);
    }
    return { ran: true };
  }

  return {
    status,
    runIfDue,
    setSchedule: async (cron) => {
      const own = cron === null ? null : normalizeCron(cron);
      const row = { cron: own, ...nextFor(own ?? defaultCron) };
      if (!(await store.write(row))) throw new Error("org_not_found");
      return describe(row, row.nextAt);
    },
    clockMoved: async (how) => {
      if (how === "advanced") return runIfDue();
      const row = await store.read();
      if (row) await store.write(nextFor(row.cron ?? defaultCron));
      return { ran: false };
    },
  };
}

/**
 * The cadence of an orchestrator that runs one org on the queue's one epoch
 * schedule. The queue fires on the wall clock, so that is the clock the next
 * time is told on, and skipping a sandbox's clock forward does not bring it
 * closer.
 */
export function processEpochStatus(
  schedule: string | null,
  wallNowMs: number = Date.now(),
): EpochCadenceStatus {
  const at = schedule ? nextCronAfter(schedule, new Date(wallNowMs)) : null;
  const seconds = at ? Math.floor(at.getTime() / 1000) : null;
  return {
    schedule,
    source: "process",
    clock: "wall",
    nextAt: seconds,
    nextAtIso: seconds === null ? null : iso(seconds),
    secondsUntilNext: seconds === null ? null : Math.max(seconds - Math.floor(wallNowMs / 1000), 0),
  };
}
