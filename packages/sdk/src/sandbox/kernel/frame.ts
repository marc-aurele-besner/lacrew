/**
 * Call-frame helpers shared by every kernel contract: emitting a log, calling
 * as another contract, and making an external call whose failure is contained.
 */

import { SimRevert, type Address, type CallContext, type Hex } from "./types.js";

export function emit<W>(
  ctx: CallContext<W>,
  address: Address,
  contract: string,
  name: string,
  args: Record<string, unknown>,
): void {
  ctx.events.push({ address, contract, name, args });
}

/** The same transaction, one frame deeper: `sender` becomes `msg.sender`. */
export function asSender<W>(ctx: CallContext<W>, sender: Address): CallContext<W> {
  return { world: ctx.world, sender, now: ctx.now, events: ctx.events, env: ctx.env };
}

/**
 * `target.call(data)` from `from`, returning whether it succeeded.
 *
 * A failed low-level call reverts only its own frame, so the state and the
 * logs are put back to where they stood before it. State is restored by
 * replacing the world's top-level fields: a reference into the world taken
 * before the call is stale afterwards, and callers write nothing through one.
 */
export function externalCall<W extends object>(
  ctx: CallContext<W>,
  from: Address,
  target: Address,
  data: Hex,
): boolean {
  const snapshot = structuredClone(ctx.world);
  const mark = ctx.events.length;
  try {
    ctx.env.dispatch(asSender(ctx, from), target, data);
    return true;
  } catch (err) {
    if (!(err instanceof SimRevert)) throw err;
    const world = ctx.world as Record<string, unknown>;
    for (const key of Object.keys(world)) delete world[key];
    Object.assign(world, snapshot);
    ctx.events.length = mark;
    return false;
  }
}
