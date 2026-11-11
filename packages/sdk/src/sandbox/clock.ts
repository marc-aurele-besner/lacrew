/**
 * Wall time for a sandbox that should move with the world.
 *
 * Lives outside the kernel on purpose: the kernel only ever sees a `Clock`.
 * `offsetSeconds` is how "advance time" works on a running sandbox — the
 * caller persists the offset and time jumps without the process sleeping.
 */

import type { Clock } from "./kernel/index.js";

export function systemClock(offsetSeconds: () => number = () => 0): Clock {
  return { now: () => Math.floor(Date.now() / 1000) + offsetSeconds() };
}
