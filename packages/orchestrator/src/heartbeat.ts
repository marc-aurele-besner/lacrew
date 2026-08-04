/**
 * Crew heartbeat runner (PRD F2.21): the thing that actually works through a
 * crew's standing checklist and reports back.
 *
 * `@lacrew/flows` owns what a heartbeat *is* — the shape, the cadence floor,
 * quiet hours, "is it due?" — so a CLI or a control plane can check one without
 * a running orchestrator. This module owns everything that needs the live
 * process: which flows are saved, which skills a seat's directive carries, who
 * is paused, and the one thing only this process can do — run an item.
 *
 * ## The checklist is the authority boundary
 *
 * Every item names a flow id or a skill id an operator put there. Nothing here
 * chooses work, and there is no path from a model's output to a tool call that
 * was not already on the list. A flow item runs down the same `flows.run` path
 * a manual run takes, as a declared principal, so the policy stack, the session
 * key's onchain ceiling, the pause gate and Approvals all still apply — a
 * heartbeat changes when work happens and never what may happen.
 *
 * A skill item is narrower still: the skill's body is put to the model as a
 * single `model` step, which has no tool access at all. That is what keeps
 * "the checklist may reference skill ids" from quietly meaning "the model gets
 * the tool belt on a timer".
 *
 * ## Exactly once, across replicas
 *
 * The sweep is dispatched by the queue, so one replica gets each minute. That
 * alone is not enough: a redelivered job, or a tick still running when the next
 * window opens, would work the same list twice. So the runner *claims* the
 * window in the store before doing anything — the tick row is the claim — and
 * refuses to start while an unfinished tick for the same crew is younger than
 * `STALE_TICK_MS`. Older than that, the process holding it is presumed dead and
 * the next window proceeds; a crew whose heartbeat stopped forever because one
 * replica was OOM-killed mid-tick is the worse failure.
 *
 * ## Silence is a decision, not a default
 *
 * A heartbeat that posts nothing when all is well is indistinguishable from one
 * that stopped running, and the entire value is that a human can tell. So a
 * clean tick posts a short `HEARTBEAT_OK` note unless the operator turned that
 * off, and anything that failed, waited or was skipped is posted whatever the
 * setting says — `notifyOnOk` governs the quiet case only, and never suppresses
 * a failure.
 */

import {
  heartbeatDue,
  heartbeatWindowKey,
  normalizeHeartbeat,
  type CrewHeartbeat,
  type FlowDefinition,
  type FlowRunResult,
  type HeartbeatItem,
} from "@lacrew/flows";
import type { Message, MessageRef } from "./conversation.js";
import type { FlowsSurface } from "./flows.js";
import {
  createHeartbeatStoreFromEnv,
  type HeartbeatItemResult,
  type HeartbeatStore,
  type HeartbeatTick,
} from "./heartbeatStore.js";
import type { CrewRuntime } from "./runtime.js";

/**
 * How long an unfinished tick blocks the next one.
 *
 * Long enough that a slow checklist is never run twice concurrently, short
 * enough that a replica killed mid-tick does not silence a crew's heartbeat
 * until someone notices.
 */
const STALE_TICK_MS = 30 * 60_000;

/** How much of a run's own reporting is carried into the thread summary. */
const DETAIL_MAX_CHARS = 240;

export type HeartbeatSurface = {
  list(): CrewHeartbeat[];
  get(crewId: string): CrewHeartbeat | undefined;
  /**
   * Validate against this live process and store. Refuses a checklist naming a
   * flow or skill that does not exist here — an operator whose typo is accepted
   * finds out at 03:00, from a thread note nobody reads until morning.
   */
  save(input: Partial<CrewHeartbeat> & { crewId: string }): Promise<CrewHeartbeat>;
  setEnabled(crewId: string, enabled: boolean): Promise<CrewHeartbeat>;
  remove(crewId: string): Promise<boolean>;
  /** Fire every heartbeat due at `now`; returns the ticks that actually ran. */
  sweep(now?: Date): Promise<HeartbeatTick[]>;
  /** Run one crew's checklist regardless of schedule (an operator pressed it). */
  runNow(crewId: string): Promise<HeartbeatTick>;
  ticks(limit?: number, crewId?: string): Promise<HeartbeatTick[]>;
  hydrate(): Promise<number>;
  storeName: string;
};

export function createHeartbeatSurface(opts: {
  runtime: CrewRuntime;
  flows: FlowsSurface;
  store?: HeartbeatStore;
  /**
   * Whether a hard inference budget (F2.28) has stopped this seat's crew.
   *
   * A heartbeat is the most frequent thing a crew does and the least likely to
   * be the thing a person is waiting on, so it is the first spend to stop when
   * the money runs out. Without this the timer keeps firing into a guard that
   * refuses every call, and the crew thread fills with failures nobody can act
   * on. Absent, heartbeats run as they always did.
   */
  budgetBlock?: (principal: string) => Promise<{ scopeKey: string; dimension: string } | null>;
}): HeartbeatSurface {
  const store = opts.store ?? createHeartbeatStoreFromEnv();
  const configs = new Map<string, CrewHeartbeat>();
  /** Crews this process is mid-tick on; the store covers the other replicas. */
  const inFlight = new Set<string>();
  /** Distinguishes two presses inside the same millisecond. */
  let manualSeq = 0;

  const principalOf = (config: CrewHeartbeat, item?: HeartbeatItem): `0x${string}` =>
    (item?.as ?? config.principal ?? opts.runtime.defaultAgent) as `0x${string}`;

  /** The named skill on this seat's directive, if it carries one. */
  const skillFor = (
    principal: string,
    id: string,
  ): { name: string; when?: string; instructions: string } | null => {
    const brief = opts.runtime.agentBrief(principal as `0x${string}`);
    const wanted = id.trim().toLowerCase();
    for (const layer of brief?.layers ?? []) {
      for (const skill of layer.skills ?? []) {
        if (skill.name.trim().toLowerCase() === wanted) return skill;
      }
    }
    return null;
  };

  /**
   * A skill item as a one-step flow.
   *
   * Deliberately a `model` step and nothing else. The step reads the skill and
   * reports; it cannot call a tool, so a skill whose prose says "merge it" is a
   * recommendation in a thread rather than a merge, and the operator's next move
   * is to put the flow that merges on the checklist instead.
   */
  const skillFlow = (
    config: CrewHeartbeat,
    item: HeartbeatItem,
    skill: { name: string; when?: string; instructions: string },
  ): FlowDefinition => ({
    id: `heartbeat:${config.crewId}:${item.id}`,
    name: `Heartbeat — ${skill.name}`,
    description: `Crew heartbeat checklist item for ${config.crewId}`,
    steps: [
      {
        id: "skill",
        kind: "model",
        label: skill.name,
        ...(config.model ? { model: config.model } : {}),
        prompt:
          `Standing checklist item for this crew's heartbeat.\n\n` +
          `Skill: ${skill.name}\n` +
          (skill.when ? `Use when: ${skill.when}\n` : "") +
          `\n${skill.instructions}\n\n` +
          (item.input ? `Context for this run:\n${item.input}\n\n` : "") +
          `Report only what a human needs to know. If nothing needs attention, ` +
          `reply with exactly: NOTHING TO REPORT. You have no tools on this ` +
          `step — describe what should happen, do not claim to have done it.`,
        next: null,
      },
    ],
  });

  /** The last line a run produced, trimmed to something a thread can carry. */
  const detailOf = (result: FlowRunResult): string | undefined => {
    const step = [...result.steps].reverse().find((s) => s.error || s.summary);
    const raw = (step?.error ?? step?.summary ?? "").trim();
    if (!raw) return undefined;
    return raw.length > DETAIL_MAX_CHARS ? `${raw.slice(0, DETAIL_MAX_CHARS)}…` : raw;
  };

  /**
   * A skill item reports "nothing to report" as an ordinary completion — the
   * point of asking is that most ticks find nothing, and treating a quiet
   * answer as noteworthy would make every tick noteworthy.
   */
  const isQuietReport = (detail: string | undefined): boolean =>
    !detail || /^nothing to report\b/i.test(detail.trim());

  const runItem = async (
    config: CrewHeartbeat,
    item: HeartbeatItem,
  ): Promise<HeartbeatItemResult> => {
    const principal = principalOf(config, item);
    const base = { kind: item.kind, id: item.id, principal } as const;

    // Checked before anything runs, and reported rather than swallowed: an
    // operator who paused a seat is entitled to know its standing work stopped
    // with it, not to discover a silent gap in the ledger.
    if (opts.runtime.isAgentPaused(principal)) {
      return { ...base, status: "skipped", detail: "agent_paused" };
    }

    try {
      if (item.kind === "skill") {
        const skill = skillFor(principal, item.id);
        if (!skill) {
          return { ...base, status: "failed", detail: "skill_not_on_directive" };
        }
        const result = await opts.flows.run({
          flow: skillFlow(config, item, skill),
          as: principal,
          trigger: "heartbeat",
          ...(item.input ? { input: item.input } : {}),
        });
        const detail = detailOf(result);
        if (result.status !== "completed") {
          return {
            ...base,
            status: result.status === "waiting" ? "attention" : "failed",
            runId: result.runId,
            ...(detail ? { detail } : {}),
          };
        }
        return {
          ...base,
          status: isQuietReport(detail) ? "ok" : "attention",
          runId: result.runId,
          ...(detail && !isQuietReport(detail) ? { detail } : {}),
        };
      }

      const result = await opts.flows.run({
        id: item.id,
        as: principal,
        trigger: "heartbeat",
        // Read the definition through the store: the replica that saved a flow
        // and the one the sweep landed on are routinely different processes.
        refresh: true,
        ...(item.input ? { input: item.input } : {}),
      });
      const detail = detailOf(result);
      const status: HeartbeatItemResult["status"] =
        result.status === "completed" ? "ok" : result.status === "waiting" ? "attention" : "failed";
      return {
        ...base,
        status,
        runId: result.runId,
        ...(detail && status !== "ok" ? { detail } : {}),
      };
    } catch (err) {
      return {
        ...base,
        status: "failed",
        detail: err instanceof Error ? err.message : "unknown_error",
      };
    }
  };

  /** What the crew's thread is told, and whether it is told anything at all. */
  const postSummary = (config: CrewHeartbeat, items: HeartbeatItemResult[]): Message | null => {
    const attention = items.filter((i) => i.status !== "ok");
    const refs: MessageRef[] = items
      .filter((i) => i.runId)
      .map((i) => ({ kind: "flowRun" as const, id: i.runId! }));

    if (attention.length === 0) {
      if (!config.notifyOnOk) return null;
      return opts.runtime.postMessage({
        scope: { kind: "crew", id: config.crewId },
        author: principalOf(config),
        authorKind: "agent",
        kind: "note",
        body:
          `HEARTBEAT_OK — ${items.length} checklist item(s) ran, nothing needs you.\n` +
          items.map((i) => `- ${i.kind} ${i.id}: ok`).join("\n"),
        ...(refs.length > 0 ? { refs } : {}),
      });
    }

    // A `result`, not a `question`: the heartbeat is reporting what it found,
    // and a question posted every tick would fill the Questions rail with
    // entries nobody can close. The items that genuinely need an answer ask it
    // themselves — an ask-mode connector write posts its own question, in the
    // thread, where answering it releases the step that is waiting.
    const lines = items.map((i) => {
      const detail = i.detail ? ` — ${i.detail}` : "";
      return `- ${i.kind} ${i.id} (${i.principal}): ${i.status}${detail}`;
    });
    return opts.runtime.postMessage({
      scope: { kind: "crew", id: config.crewId },
      author: principalOf(config),
      authorKind: "agent",
      kind: "result",
      body:
        `Heartbeat — ${attention.length} of ${items.length} item(s) need you.\n` + lines.join("\n"),
      ...(refs.length > 0 ? { refs } : {}),
    });
  };

  const tickStatus = (items: HeartbeatItemResult[]): HeartbeatTick["status"] => {
    if (items.some((i) => i.status === "failed")) return "failed";
    if (items.some((i) => i.status === "attention")) return "attention";
    if (items.length > 0 && items.every((i) => i.status === "skipped")) return "skipped";
    return "ok";
  };

  /**
   * Whether a hard cost budget is holding this crew's timer.
   *
   * A budget that cannot be read does **not** hold the heartbeat: unlike a
   * model call, a tick spends nothing by starting, and each call it goes on to
   * make is guarded on its own. Stopping a crew's standing supervision because
   * a lookup failed would be the more expensive mistake.
   */
  const budgetBlockFor = async (
    config: CrewHeartbeat,
  ): Promise<{ scopeKey: string; dimension: string } | null> => {
    if (!opts.budgetBlock) return null;
    try {
      return await opts.budgetBlock(principalOf(config));
    } catch (err) {
      console.error(
        `[@lacrew/orchestrator] heartbeat "${config.crewId}" budget check failed:`,
        err,
      );
      return null;
    }
  };

  /** True when another tick for this crew is still running somewhere. */
  const busy = async (crewId: string): Promise<boolean> => {
    if (inFlight.has(crewId)) return true;
    if (!store.durable) return false;
    const [last] = await store.recentTicks(1, crewId);
    if (!last || last.status !== "running" || last.finishedAt) return false;
    return Date.now() - Date.parse(last.startedAt) < STALE_TICK_MS;
  };

  const runChecklist = async (config: CrewHeartbeat, windowKey: string): Promise<HeartbeatTick> => {
    const startedAt = new Date().toISOString();
    inFlight.add(config.crewId);
    const items: HeartbeatItemResult[] = [];
    try {
      for (const item of config.checklist) {
        const result = await runItem(config, item);
        items.push(result);
        // A failing item stops the tick only when the operator asked for that.
        // The default is to keep going: a checklist is a list of independent
        // standing questions, and one broken flow should not hide the answer
        // to the other five.
        if (config.stopOnError && result.status === "failed") break;
      }
    } finally {
      inFlight.delete(config.crewId);
    }

    const message = postSummary(config, items);
    const status = tickStatus(items);
    await store.settleTick({
      crewId: config.crewId,
      windowKey,
      status,
      items,
      ...(message ? { messageId: message.id } : {}),
    });
    opts.runtime.recordAudit({
      type: "CrewHeartbeat",
      at: new Date().toISOString(),
      payload: {
        crewId: config.crewId,
        windowKey,
        status,
        items: items.length,
        attention: items.filter((i) => i.status === "attention").length,
        failed: items.filter((i) => i.status === "failed").length,
        skipped: items.filter((i) => i.status === "skipped").length,
        runs: items.filter((i) => i.runId).map((i) => i.runId),
        ...(message ? { messageId: message.id } : {}),
        durationMs: Date.now() - Date.parse(startedAt),
      },
    });
    return {
      crewId: config.crewId,
      windowKey,
      status,
      items,
      ...(message ? { messageId: message.id } : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  };

  /** Everything on the checklist has to already exist here. */
  const checkChecklist = async (config: CrewHeartbeat): Promise<void> => {
    for (const item of config.checklist) {
      if (item.kind === "flow") {
        const found = await opts.flows.get(item.id, { refresh: true });
        if (!found) throw new Error(`heartbeat_unknown_flow: ${item.id}`);
        continue;
      }
      const principal = principalOf(config, item);
      if (!skillFor(principal, item.id)) {
        throw new Error(`heartbeat_unknown_skill: ${item.id} (on ${principal})`);
      }
    }
  };

  const surface: HeartbeatSurface = {
    list: () => [...configs.values()],
    get: (crewId) => configs.get(crewId.trim().toLowerCase()),
    save: async (input) => {
      const config = normalizeHeartbeat(input);
      await checkChecklist(config);
      // Store first: a config this process beats to but never wrote is one the
      // operator was told was saved and that vanishes on restart.
      await store.save(config);
      configs.set(config.crewId, config);
      opts.runtime.recordAudit({
        type: "CrewHeartbeatChanged",
        at: config.updatedAt,
        payload: {
          crewId: config.crewId,
          action: "saved",
          schedule: config.schedule,
          timezone: config.timezone ?? "UTC",
          items: config.checklist.length,
          enabled: config.enabled,
          principal: config.principal ?? null,
        },
      });
      return config;
    },
    setEnabled: async (crewId, enabled) => {
      const key = crewId.trim().toLowerCase();
      const current = configs.get(key) ?? (await store.get(key));
      if (!current) throw new Error("heartbeat_not_found");
      return surface.save({ ...current, enabled });
    },
    remove: async (crewId) => {
      const key = crewId.trim().toLowerCase();
      const existed = configs.delete(key);
      await store.remove(key);
      if (existed) {
        opts.runtime.recordAudit({
          type: "CrewHeartbeatChanged",
          at: new Date().toISOString(),
          payload: { crewId: key, action: "removed" },
        });
      }
      return existed;
    },
    sweep: async (now = new Date()) => {
      const ticks: HeartbeatTick[] = [];
      for (const config of configs.values()) {
        const due = heartbeatDue(config, now);
        if (!due.due) continue;
        if (await busy(config.crewId)) continue;
        // Before the claim, so a stopped heartbeat leaves no tick row at all:
        // a ledger full of skipped windows says the same thing as a gap, at the
        // cost of hiding the ticks that did run. The alert that announced the
        // breach is the record, and it fired once.
        const blocked = await budgetBlockFor(config);
        if (blocked) {
          console.log(
            `[@lacrew/orchestrator] heartbeat "${config.crewId}" held: ` +
              `${blocked.scopeKey} is over its ${blocked.dimension} inference budget`,
          );
          continue;
        }
        const windowKey = heartbeatWindowKey(config, now);
        let claimed = false;
        try {
          claimed = await store.claimTick({ crewId: config.crewId, windowKey });
        } catch (err) {
          // An unrecordable claim is not a claim: without the row two replicas
          // would both work the list, so the tick is skipped and said so.
          console.error(
            `[@lacrew/orchestrator] heartbeat "${config.crewId}" could not claim ${windowKey}:`,
            err,
          );
          continue;
        }
        if (!claimed) continue;
        try {
          ticks.push(await runChecklist(config, windowKey));
        } catch (err) {
          console.error(`[@lacrew/orchestrator] heartbeat "${config.crewId}" failed:`, err);
        }
      }
      return ticks;
    },
    runNow: async (crewId) => {
      const key = crewId.trim().toLowerCase();
      const config = configs.get(key) ?? (await store.get(key));
      if (!config) throw new Error("heartbeat_not_found");
      if (config.checklist.length === 0) throw new Error("heartbeat_checklist_empty");
      // Refused up front rather than left to fail item by item. Every model
      // call in the tick would be refused anyway; saying so once is a reason
      // the operator can act on, where a list of identical failures is not.
      const held = await budgetBlockFor(config);
      if (held) {
        throw new Error(
          `inference_budget_exceeded: ${held.scopeKey} is over its ${held.dimension} budget`,
        );
      }
      if (await busy(key)) throw new Error("heartbeat_already_running");
      // Prefixed so a pressed run can never take the window a scheduled tick
      // would have used — an operator checking their config must not suppress
      // the very tick they were testing — and stamped to the millisecond rather
      // than the minute, because two presses a few seconds apart are two things
      // the operator asked for. Overlap is what `busy` refuses; a minute-shaped
      // key would have called the second press "already running" when the first
      // had finished.
      manualSeq += 1;
      const windowKey = `manual:${key}@${new Date().toISOString()}#${manualSeq}`;
      const claimed = await store.claimTick({ crewId: key, windowKey });
      if (!claimed) throw new Error("heartbeat_already_running");
      return runChecklist(config, windowKey);
    },
    ticks: async (limit = 20, crewId) =>
      store.recentTicks(limit, crewId ? crewId.trim().toLowerCase() : undefined),
    hydrate: async () => {
      for (const config of await store.list()) configs.set(config.crewId, config);
      await store.prune();
      return configs.size;
    },
    storeName: store.name,
  };
  return surface;
}
