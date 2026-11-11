/**
 * A clock that moves only when told to. The kernel never reads wall time; a
 * caller that wants real time supplies its own `Clock`.
 */

import type { Clock } from "./types.js";

export interface ManualClock extends Clock {
  /** Move forward by `seconds`. */
  advance(seconds: number): void;
  /** Jump to `timestamp`. Time does not run backwards. */
  set(timestamp: number): void;
}

export function manualClock(start: number): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance(seconds: number) {
      if (!Number.isInteger(seconds) || seconds < 0) {
        throw new Error("a clock advances by a whole, non-negative number of seconds");
      }
      current += seconds;
    },
    set(timestamp: number) {
      if (!Number.isInteger(timestamp) || timestamp < current) {
        throw new Error("a clock cannot be set to a time before its own");
      }
      current = timestamp;
    },
  };
}
