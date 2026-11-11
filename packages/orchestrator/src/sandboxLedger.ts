/**
 * The sandbox ledger: one org's simulator, its clock, and the state that
 * survives a restart.
 *
 * A sandbox is a simulation. The contract rules are applied in process by the
 * kernel behind `@lacrew/sdk/sandbox`; nothing is mined, no key signs, and no
 * contract enforces anything. It exists only when an operator asked for it by
 * name (`LACREW_MODE=sandbox`) and is never what a runtime falls back to.
 *
 * State is written through after every committed simulator transaction, with
 * an optimistic version check, to Postgres when DATABASE_URL is set and to
 * memory otherwise — the same provider pattern as the other stores.
 */

import {
  DEFAULT_ORG_ID,
  getDatabaseUrl,
  loadSandboxState,
  orgDb,
  saveSandboxState,
} from "@lacrew/db";
import { sharedDb } from "./dbPool.js";
import type { DbHandle } from "@lacrew/db";
import {
  createSandboxClient,
  type SandboxLacrewClient,
  type SandboxSnapshot,
} from "@lacrew/sdk/sandbox";

/** The org id a single-org orchestrator stores its sandbox under. */
export const DEFAULT_SANDBOX_ORG = DEFAULT_ORG_ID;

/**
 * The human root of a sandbox whose operator named none. Nobody holds a key
 * for it and none is needed: a sandbox verifies no signature, so whoever may
 * call the orchestrator stands in for the root.
 */
export const DEFAULT_SANDBOX_ROOT = "0x5a17b0c5000000000000000000000000000000a1" as const;

/** Most play money one `fund` call may credit: 1,000,000 units of a 6-decimal token. */
export const SANDBOX_MAX_FUND = 1_000_000n * 10n ** 6n;
/** Furthest one `advance` call may move the clock: 366 days. */
export const SANDBOX_MAX_ADVANCE_SECONDS = 366 * 24 * 60 * 60;

export interface SandboxStateRecord {
  /** How many writes produced this record; the optimistic lock. */
  version: number;
  state: SandboxSnapshot;
  /** Seconds the sandbox clock runs ahead of wall time. */
  clockOffset: number;
}

export interface SandboxStateStore {
  readonly name: string;
  load(): Promise<SandboxStateRecord | null>;
  /**
   * Write `record` only if the stored version is still `expectedVersion`
   * (0 = nothing stored yet). False means another writer got there first.
   */
  save(record: SandboxStateRecord, expectedVersion: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Holds one org's state for the life of the process (or of a test). */
export function createMemorySandboxStateStore(): SandboxStateStore {
  let row: SandboxStateRecord | undefined;
  return {
    name: "memory",
    load: async () => (row ? structuredClone(row) : null),
    save: async (record, expectedVersion) => {
      if ((row?.version ?? 0) !== expectedVersion) return false;
      row = structuredClone(record);
      return true;
    },
    close: async () => {},
  };
}

/** One org's stored simulation: every read and write is bound to `orgId`. */
export function createPgSandboxStateStore(options: {
  db: DbHandle;
  orgId: string;
}): SandboxStateStore {
  const scoped = orgDb(options.db, options.orgId);
  const db = () => scoped;
  return {
    name: "postgres",
    load: async () => {
      const row = await loadSandboxState(db());
      if (!row) return null;
      return {
        version: row.version,
        state: row.state as SandboxSnapshot,
        clockOffset: row.clockOffset,
      };
    },
    save: (record, expectedVersion) =>
      saveSandboxState(
        db(),
        {
          version: record.version,
          state: record.state,
          clockOffset: record.clockOffset,
        },
        expectedVersion,
      ),
    // The pool belongs to whoever injected it, and is closed there.
    close: async () => {},
  };
}

/** Postgres when DATABASE_URL is set, memory otherwise. */
export function createSandboxStateStoreFromEnv(orgId: string): SandboxStateStore {
  return getDatabaseUrl()
    ? createPgSandboxStateStore({ db: sharedDb(), orgId })
    : createMemorySandboxStateStore();
}

/** Raised when a sandbox control is asked of a runtime that is not a sandbox. */
export class NotSandboxError extends Error {
  readonly code = "not_sandbox";
  constructor() {
    super("not_sandbox");
    this.name = "NotSandboxError";
  }
}

/** A refused sandbox control call; `code` is stable for callers to branch on. */
export class SandboxControlError extends Error {
  constructor(
    readonly code: "invalid_amount" | "amount_too_large" | "invalid_seconds" | "seconds_too_large",
    readonly detail: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = "SandboxControlError";
  }
}

export interface SandboxLedgerOptions {
  /** The org's human root. Defaults to `DEFAULT_SANDBOX_ROOT`. */
  root?: `0x${string}`;
  /** The org this sandbox is, as its status reports it. Defaults to `default`. */
  orgId?: string;
  /** Where state is kept. Defaults to memory. */
  store?: SandboxStateStore;
  /** Wall time in ms; the sandbox clock is this plus the offset. Defaults to `Date.now`. */
  wallClock?: () => number;
}

export class SandboxLedger {
  readonly orgId: string;
  readonly root: `0x${string}`;
  private readonly store: SandboxStateStore;
  private readonly wallClock: () => number;
  private current: SandboxLacrewClient;
  private offset = 0;
  /** Version of the newest state held in memory. */
  private held = 0;
  /** Version the store is known to hold. */
  private stored = 0;
  /** Bumped when stored state replaces the state held here; queued writes of the old state are dropped. */
  private generation = 0;
  /** Writes run one at a time, in commit order. */
  private writes: Promise<void> = Promise.resolve();
  private failure: string | null = null;
  private lost = 0;

  constructor(options: SandboxLedgerOptions = {}) {
    this.orgId = options.orgId ?? DEFAULT_SANDBOX_ORG;
    this.root = options.root ?? DEFAULT_SANDBOX_ROOT;
    this.store = options.store ?? createMemorySandboxStateStore();
    this.wallClock = options.wallClock ?? Date.now;
    this.current = this.build();
  }

  /** The simulator as it stands now. A reset replaces it, so never hold on to it. */
  get client(): SandboxLacrewClient {
    return this.current;
  }

  get storeName(): string {
    return this.store.name;
  }

  /** How many writes produced the state held now. */
  get version(): number {
    return this.held;
  }

  /** Seconds the sandbox clock runs ahead of wall time. */
  get clockOffset(): number {
    return this.offset;
  }

  /** Unix seconds on the sandbox clock. */
  now(): number {
    return Math.floor(this.wallClock() / 1000) + this.offset;
  }

  /**
   * How many times this process lost the version check and adopted the stored
   * state. Each one discarded whatever this process had committed since its
   * last write that landed, so a caller compares this around a write to learn
   * whether its own call survived.
   */
  get conflicts(): number {
    return this.lost;
  }

  /** Why the last write-through did not land, or null when state is durable. */
  get persistError(): string | null {
    return this.failure;
  }

  private build(snapshot?: SandboxSnapshot): SandboxLacrewClient {
    return createSandboxClient({
      ...(snapshot ? { snapshot } : { root: this.root }),
      clock: { now: () => this.now() },
      onCommit: (commit) => this.writeThrough(commit.snapshot()),
    });
  }

  /**
   * Resume the stored simulation, or store this genesis when there is none.
   * Call once at boot, after migrations and before anything writes. Returns
   * whether stored state was found.
   */
  async hydrate(): Promise<boolean> {
    const record = await this.store.load();
    if (!record) {
      this.writeThrough(this.current.snapshot());
      await this.flush();
      return false;
    }
    this.offset = record.clockOffset;
    this.held = record.version;
    this.stored = record.version;
    this.current = this.build(record.state);
    return true;
  }

  /** Queue one versioned write of `state` behind the writes already queued. */
  private writeThrough(state: SandboxSnapshot): void {
    const version = (this.held += 1);
    const clockOffset = this.offset;
    const generation = this.generation;
    this.writes = this.writes.then(async () => {
      // A write that lost the version check already replaced this state with
      // the stored one; the writes queued behind it describe a world that no
      // longer exists.
      if (generation !== this.generation) return;
      try {
        const landed = await this.store.save({ version, state, clockOffset }, this.stored);
        if (landed) {
          this.stored = version;
          this.failure = null;
          return;
        }
        await this.adoptStored();
      } catch (err) {
        // Kept, not thrown: the simulator already committed, and the next
        // write carries the whole state again. The caller reads this on
        // `GET /sandbox` instead of believing a restart would resume here.
        this.failure = err instanceof Error ? err.message.split("\n")[0]! : "write failed";
      }
    });
  }

  /**
   * Another process wrote this org's sandbox first. Its state stands: adopt
   * it, so this process converges on the stored simulation and never
   * overwrites it with one that forked.
   */
  private async adoptStored(): Promise<void> {
    const record = await this.store.load();
    this.generation += 1;
    this.lost += 1;
    this.failure = null;
    if (!record) {
      this.held = this.stored = 0;
      return;
    }
    this.offset = record.clockOffset;
    this.held = this.stored = record.version;
    this.current = this.build(record.state);
  }

  /** Wait for every queued write. Resolves whether or not they landed; see `persistError`. */
  async flush(): Promise<void> {
    await this.writes;
  }

  /** Credit `amount` of play money to the treasury. Grants no allowance. */
  async fund(amount: bigint): Promise<{ simTxId: string }> {
    if (amount <= 0n) throw new SandboxControlError("invalid_amount");
    if (amount > SANDBOX_MAX_FUND) {
      throw new SandboxControlError("amount_too_large", { max: SANDBOX_MAX_FUND.toString() });
    }
    const { simTxId } = await this.current.fund(amount);
    return { simTxId: simTxId! };
  }

  /** Move the sandbox clock forward. Time never goes back; a reset starts it over. */
  async advance(seconds: number): Promise<{ now: number; clockOffset: number }> {
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw new SandboxControlError("invalid_seconds");
    }
    if (seconds > SANDBOX_MAX_ADVANCE_SECONDS) {
      throw new SandboxControlError("seconds_too_large", { max: SANDBOX_MAX_ADVANCE_SECONDS });
    }
    this.offset += seconds;
    this.writeThrough(this.current.snapshot());
    await this.flush();
    return { now: this.now(), clockOffset: this.offset };
  }

  /** Throw the simulation away and start from genesis: one root, no funds, clock at wall time. */
  async reset(): Promise<void> {
    await this.flush();
    this.offset = 0;
    this.current = this.build();
    this.writeThrough(this.current.snapshot());
    await this.flush();
  }

  async close(): Promise<void> {
    await this.flush();
    await this.store.close();
  }
}
