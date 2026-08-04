/**
 * Crew heartbeat: the standing checklist a crew works through on its own
 * cadence (PRD F2.21).
 *
 * A crew already runs when a human presses Run, when an epoch fires, when a
 * cron expression on a flow matches, and when a signed webhook arrives. None of
 * those is "every half hour, work through this desk's list and tell us what
 * needs a person". Operators answer that today by over-scheduling crons or by
 * not running at all and finding out late.
 *
 * The obvious alternative — let the crew decide what to do each tick — is the
 * thing this deliberately is not:
 *
 *   A heartbeat may only invoke work that was **named in advance**. Every item
 *   is a flow id or a skill id that already exists on this orchestrator, put
 *   there by an operator. There is no step where a model chooses what to do
 *   with the tools it has. A wake that could pick its own work would widen
 *   authority on a timer, and no cap, whitelist or session scope is written to
 *   survive that.
 *
 * The heartbeat widens nothing else either: each item runs as a declared
 * principal, down the same path a manual run takes, so the policy stack, the
 * session key's onchain ceiling, the pause gate and Approvals all still apply.
 * What it changes is *when* work happens, never *what may happen*.
 *
 * ## Why this module holds no orchestrator
 *
 * Validation and the "is it due?" decision are pure, so a CLI can check a
 * checklist, and a control plane can reject a bad one, without booting a
 * runtime. Everything that needs the live process — which flows are saved,
 * which skills a seat's directive carries, who is paused — lives in
 * `@lacrew/orchestrator`, which is also the only thing that can run an item.
 */

import { cronMatchesInZone, cronMinuteGap, isValidCron, isValidTimeZone } from "./cron.js";

/**
 * What a checklist entry names.
 *
 * `flow` — a saved flow definition, run as the item's principal.
 * `skill` — a named skill on that principal's directive, put to the model as a
 * single constrained step. A skill item can read and reason and report; it
 * cannot call anything, which is what keeps "the checklist may reference skill
 * ids" from becoming "the model gets the tool belt on a timer".
 */
export type HeartbeatItemKind = "flow" | "skill";

export type HeartbeatItem = {
  kind: HeartbeatItemKind;
  /** Flow id, or the skill's name as it appears on the principal's directive. */
  id: string;
  /** Run input for a flow; the question put to the model for a skill. */
  input?: string;
  /** Seat this item runs as. Defaults to the heartbeat's own principal. */
  as?: string;
};

/**
 * A window in which the heartbeat does not fire, in the heartbeat's timezone.
 *
 * `"22:00"` → `"07:00"` wraps midnight; `start === end` is an empty window, not
 * a silent 24-hour mute — an operator who wanted the heartbeat off has
 * `enabled: false`, and reading a typo as "never run again" would be the most
 * expensive possible interpretation of an ambiguous config.
 */
export type QuietHours = { start: string; end: string };

export type CrewHeartbeat = {
  /** Crew this beats for; also the thread its summaries land in. */
  crewId: string;
  /** 5-field cron, evaluated in `timezone`. Presets are just expressions. */
  schedule: string;
  /** IANA zone the schedule and quiet hours are read in. Defaults to UTC. */
  timezone?: string;
  quietHours?: QuietHours;
  /** Ordered work. Empty is refused on an enabled heartbeat. */
  checklist: HeartbeatItem[];
  /** Default seat every item runs as. */
  principal?: string;
  /**
   * Model for this tick's skill items. A heartbeat is the most frequent thing
   * a crew does and the least likely to need the best model, so the override
   * exists to make the cheap choice easy to declare in one place.
   */
  model?: string;
  /**
   * Post a short note when the tick found nothing. Default true: a heartbeat
   * that is silent when all is well is indistinguishable from one that stopped
   * running, and the whole point is that a human can tell.
   */
  notifyOnOk: boolean;
  /** Stop the tick at the first failing item. Default false. */
  stopOnError: boolean;
  enabled: boolean;
  updatedAt: string;
};

/** Bounded work per tick — a checklist is a desk's standing list, not a queue. */
export const HEARTBEAT_MAX_ITEMS = 20;

/**
 * Cadence floor, in minutes.
 *
 * Every tick spends: model calls, connector calls, gas on anything that
 * proposes. A heartbeat is the one surface where a single character in the
 * minute field multiplies that tenfold with nothing in the way, so the floor is
 * enforced rather than documented. Ten minutes is well under any real
 * supervision cadence and well over the point where a mistake gets expensive.
 */
export const HEARTBEAT_MIN_INTERVAL_MINUTES = 10;

/** Cadences worth offering by name; every one is an ordinary cron expression. */
export const HEARTBEAT_PRESETS: Array<{ label: string; schedule: string }> = [
  { label: "Every 15 minutes", schedule: "*/15 * * * *" },
  { label: "Every 30 minutes", schedule: "*/30 * * * *" },
  { label: "Hourly", schedule: "0 * * * *" },
  { label: "Every 4 hours", schedule: "0 */4 * * *" },
  { label: "Twice a day", schedule: "0 9,17 * * *" },
  { label: "Weekday mornings", schedule: "0 9 * * 1-5" },
];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** Minutes since local midnight, or null when the string is not `HH:MM`. */
export function minuteOfDay(hhmm: string): number | null {
  const match = HHMM.exec(trimmed(hhmm));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export type HeartbeatValidation = { ok: boolean; errors: string[] };

/**
 * Shape-check a heartbeat. Existence of the ids it names is *not* checked here
 * — only the process holding the flows and directives can answer that, and it
 * does so at save time (`heartbeat_unknown_flow` / `heartbeat_unknown_skill`).
 */
export function validateHeartbeat(config: CrewHeartbeat): HeartbeatValidation {
  const errors: string[] = [];
  if (!trimmed(config.crewId)) errors.push("crewId is required");

  const schedule = trimmed(config.schedule);
  if (!isValidCron(schedule)) {
    errors.push(`schedule must be a valid 5-field cron expression (got "${schedule}")`);
  } else {
    const gap = cronMinuteGap(schedule);
    if (gap !== null && gap < HEARTBEAT_MIN_INTERVAL_MINUTES) {
      errors.push(
        `schedule fires every ${gap} minute(s); the floor is ${HEARTBEAT_MIN_INTERVAL_MINUTES} ` +
          "— every tick spends, so a denser cadence has to be a per-flow cron with its own reason",
      );
    }
  }

  const timezone = trimmed(config.timezone);
  if (timezone && !isValidTimeZone(timezone)) {
    errors.push(`unknown timezone "${timezone}" (IANA names, e.g. "Europe/Paris")`);
  }

  if (config.quietHours) {
    const start = minuteOfDay(config.quietHours.start);
    const end = minuteOfDay(config.quietHours.end);
    if (start === null || end === null) {
      errors.push('quietHours must be "HH:MM" 24-hour times');
    }
  }

  const items = config.checklist ?? [];
  // Refused only when enabled: a disabled heartbeat with nothing on it is a
  // half-written config an operator is still filling in, and refusing to store
  // one would make the editor unusable.
  if (config.enabled && items.length === 0) {
    errors.push("an enabled heartbeat needs at least one checklist item");
  }
  if (items.length > HEARTBEAT_MAX_ITEMS) {
    errors.push(`checklist has ${items.length} items (max ${HEARTBEAT_MAX_ITEMS})`);
  }
  items.forEach((item, i) => {
    if (item.kind !== "flow" && item.kind !== "skill") {
      errors.push(`checklist[${i}]: unknown kind "${item.kind}" (flow | skill)`);
    }
    if (!trimmed(item.id)) errors.push(`checklist[${i}]: id is required`);
    if (item.as !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(trimmed(item.as))) {
      errors.push(`checklist[${i}]: as must be a 0x address`);
    }
  });

  if (config.principal !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(trimmed(config.principal))) {
    errors.push("principal must be a 0x address");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Canonical form of a caller-supplied heartbeat, with the defaults filled in.
 * Throws on anything `validateHeartbeat` refuses — a half-normalized config is
 * worse than none, because it stores work nobody asked for.
 */
export function normalizeHeartbeat(
  input: Partial<CrewHeartbeat> & { crewId: string },
  at = new Date().toISOString(),
): CrewHeartbeat {
  const config: CrewHeartbeat = {
    crewId: trimmed(input.crewId).toLowerCase(),
    schedule: trimmed(input.schedule),
    ...(trimmed(input.timezone) ? { timezone: trimmed(input.timezone) } : {}),
    ...(input.quietHours
      ? {
          quietHours: {
            start: trimmed(input.quietHours.start),
            end: trimmed(input.quietHours.end),
          },
        }
      : {}),
    checklist: (input.checklist ?? []).map((item) => ({
      kind: item.kind,
      id: trimmed(item.id),
      ...(trimmed(item.input) ? { input: trimmed(item.input) } : {}),
      ...(trimmed(item.as) ? { as: trimmed(item.as).toLowerCase() } : {}),
    })),
    ...(trimmed(input.principal) ? { principal: trimmed(input.principal).toLowerCase() } : {}),
    ...(trimmed(input.model) ? { model: trimmed(input.model) } : {}),
    notifyOnOk: input.notifyOnOk ?? true,
    stopOnError: input.stopOnError ?? false,
    enabled: input.enabled ?? false,
    updatedAt: at,
  };
  const check = validateHeartbeat(config);
  if (!check.ok) throw new Error(`invalid_heartbeat: ${check.errors.join("; ")}`);
  return config;
}

/** Whether `now` falls inside the configured quiet window. */
export function inQuietHours(config: CrewHeartbeat, now: Date): boolean {
  if (!config.quietHours) return false;
  const start = minuteOfDay(config.quietHours.start);
  const end = minuteOfDay(config.quietHours.end);
  if (start === null || end === null || start === end) return false;
  const at = zonedMinuteOfDay(config, now);
  // A window that wraps midnight is the common one ("22:00" → "07:00"), so it
  // is the union of two ranges rather than an inverted comparison.
  return start < end ? at >= start && at < end : at >= start || at < end;
}

function zonedMinuteOfDay(config: CrewHeartbeat, now: Date): number {
  const zone = config.timezone ?? "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(now);
  const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return (value("hour") % 24) * 60 + value("minute");
}

export type HeartbeatDue =
  { due: true } | { due: false; reason: "disabled" | "empty" | "quiet" | "not-scheduled" };

/**
 * Whether this heartbeat should fire at `now`.
 *
 * Quiet hours are a skip, not an error and not a deferral: the next window
 * outside them runs normally, and a tick that queued itself up to fire at 07:00
 * would deliver a burst of stale work at exactly the moment someone starts
 * reading.
 */
export function heartbeatDue(config: CrewHeartbeat, now: Date): HeartbeatDue {
  if (!config.enabled) return { due: false, reason: "disabled" };
  if (config.checklist.length === 0) return { due: false, reason: "empty" };
  if (inQuietHours(config, now)) return { due: false, reason: "quiet" };
  if (!cronMatchesInZone(config.schedule, now, config.timezone ?? "UTC")) {
    return { due: false, reason: "not-scheduled" };
  }
  return { due: true };
}

/**
 * Identity of one firing window, at minute resolution.
 *
 * This is what makes a tick exactly-once: the runner claims the key before
 * doing any work, and a second dispatch of the same minute — a redelivered
 * sweep, a second replica — finds it taken and does nothing. Minute resolution
 * because that is the resolution cron itself has.
 */
export function heartbeatWindowKey(config: CrewHeartbeat, now: Date): string {
  return `${config.crewId}@${now.toISOString().slice(0, 16)}Z`;
}
