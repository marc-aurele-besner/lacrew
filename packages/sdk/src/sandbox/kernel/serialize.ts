/**
 * World state as JSON and back.
 *
 * In memory every integer is a `bigint`; serialised, each is its decimal
 * string. No schema is needed to reverse that, because of one invariant the
 * kernel keeps: every other string in state is an address, a hex blob, or a
 * module kind name — none of which is made of digits alone. Object keys are
 * left as they are; ids used as keys stay strings on both sides.
 */

import type { World } from "./world.js";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const DECIMAL = /^\d+$/;

function encode(value: unknown): JsonValue {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (DECIMAL.test(value)) {
      throw new Error(
        `sandbox state holds a digits-only string "${value}"; it would read back as an integer`,
      );
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) out[key] = encode(entry);
    }
    return out;
  }
  throw new Error(`sandbox state holds a ${typeof value}, which has no JSON form`);
}

function decode(value: JsonValue): unknown {
  if (typeof value === "string") return DECIMAL.test(value) ? BigInt(value) : value;
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = decode(entry);
    return out;
  }
  return value;
}

/** A plain-JSON copy of the world: safe to `JSON.stringify` and to store. */
export function serializeWorld(world: World): JsonValue {
  return encode(world);
}

/** Rebuild a world from `serializeWorld` output. */
export function deserializeWorld(json: JsonValue): World {
  const world = decode(json) as World;
  if (world === null || typeof world !== "object" || world.version !== 1) {
    throw new Error("not a sandbox world this kernel can read (expected version 1)");
  }
  return world;
}
