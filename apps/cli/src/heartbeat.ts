/**
 * `lacrew heartbeat …` — a crew's standing checklist, from the terminal (F2.21).
 *
 * Every subcommand talks to a running orchestrator, because a checklist is only
 * meaningful against one: whether `desk-digest` exists, whether a seat's
 * directive carries `morning-review`, and who is paused are all facts about
 * that process. The one thing that is offline is `presets`, which is a list of
 * cron expressions and needs nothing.
 *
 * `run` exists so an operator can see what their config actually does without
 * waiting for 03:00. It fires the same checklist the schedule would, and takes
 * its own window, so testing a heartbeat never swallows the tick being tested.
 */

import { HEARTBEAT_PRESETS, type CrewHeartbeat, type HeartbeatItem } from "@lacrew/flows";

type TickItem = {
  kind: string;
  id: string;
  principal: string;
  status: string;
  runId?: string;
  detail?: string;
};

type Tick = {
  crewId: string;
  windowKey: string;
  status: string;
  items: TickItem[];
  messageId?: string;
  startedAt: string;
  finishedAt?: string;
};

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

function orchUrl(args: string[]): string {
  return (flagValue(args, "--url") ?? process.env.ORCH_URL ?? "http://127.0.0.1:8788").replace(
    /\/$/,
    "",
  );
}

async function orchFetch<T>(args: string[], path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.ORCH_TOKEN?.trim();
  const res = await fetch(`${orchUrl(args)}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/**
 * `--flow a,b --skill c` → an ordered checklist.
 *
 * Flows come first because that is the order they were typed in the common
 * case, and the runner honours the order it is given: an operator who wants a
 * skill to read what a flow just produced writes the two flags accordingly.
 */
function checklistFrom(args: string[]): HeartbeatItem[] {
  const items: HeartbeatItem[] = [];
  const collect = (flag: string, kind: HeartbeatItem["kind"]) => {
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== flag) continue;
      const value = args[i + 1];
      if (!value || value.startsWith("-")) continue;
      for (const id of value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        items.push({ kind, id });
      }
    }
  };
  collect("--flow", "flow");
  collect("--skill", "skill");
  return items;
}

function printHeartbeat(hb: CrewHeartbeat): void {
  console.log(`${hb.crewId}  ${hb.enabled ? "on" : "off"}`);
  console.log(`  Schedule    ${hb.schedule} (${hb.timezone ?? "UTC"})`);
  if (hb.quietHours) console.log(`  Quiet       ${hb.quietHours.start} → ${hb.quietHours.end}`);
  if (hb.principal) console.log(`  Runs as     ${hb.principal}`);
  if (hb.model) console.log(`  Model       ${hb.model}`);
  console.log(`  On OK       ${hb.notifyOnOk ? "post a short note" : "stay silent"}`);
  console.log(`  On error    ${hb.stopOnError ? "stop the tick" : "keep going"}`);
  console.log(`  Checklist   ${hb.checklist.length} item(s)`);
  for (const item of hb.checklist) {
    console.log(`    - ${item.kind} ${item.id}${item.as ? ` as ${item.as}` : ""}`);
  }
}

function printTick(tick: Tick): void {
  console.log(`${tick.crewId}  ${tick.status}  (${tick.windowKey})`);
  for (const item of tick.items) {
    const detail = item.detail ? ` — ${item.detail}` : "";
    const run = item.runId ? `  [${item.runId}]` : "";
    console.log(`  ${item.status.padEnd(9)} ${item.kind} ${item.id}${run}${detail}`);
  }
}

export async function cmdHeartbeat(args: string[]): Promise<void> {
  const [sub = "help", ...rest] = args;
  const crew = flagValue(args, "--crew") ?? (rest[0]?.startsWith("-") ? undefined : rest[0]);

  if (sub === "presets") {
    console.log("Cadences worth offering by name (all ordinary cron):\n");
    for (const preset of HEARTBEAT_PRESETS) {
      console.log(`  ${preset.schedule.padEnd(16)} ${preset.label}`);
    }
    return;
  }

  if (sub === "list") {
    const body = await orchFetch<{
      heartbeats: CrewHeartbeat[];
      minIntervalMinutes: number;
      store: string;
    }>(args, "/heartbeats");
    if (body.heartbeats.length === 0) {
      console.log("No crew has a heartbeat on this orchestrator.");
      console.log(
        "Set one:  lacrew heartbeat set --crew trading --schedule '*/30 * * * *' --flow desk-digest",
      );
      return;
    }
    for (const hb of body.heartbeats) {
      printHeartbeat(hb);
      console.log("");
    }
    console.log(`store ${body.store} · cadence floor ${body.minIntervalMinutes} minutes`);
    return;
  }

  if (sub === "show") {
    if (!crew) throw new Error("lacrew heartbeat show --crew <id>");
    const body = await orchFetch<{ heartbeats: CrewHeartbeat[] }>(args, "/heartbeats");
    const hb = body.heartbeats.find((h) => h.crewId === crew.toLowerCase());
    if (!hb) throw new Error(`No heartbeat for crew "${crew}".`);
    printHeartbeat(hb);
    return;
  }

  if (sub === "set") {
    if (!crew)
      throw new Error("lacrew heartbeat set --crew <id> --schedule '*/30 * * * *' --flow <id>");
    const schedule = flagValue(args, "--schedule");
    if (!schedule) {
      throw new Error(
        "Name the cadence: --schedule '<5-field cron>'  (see: lacrew heartbeat presets)",
      );
    }
    const quietStart = flagValue(args, "--quiet-start");
    const quietEnd = flagValue(args, "--quiet-end");
    const heartbeat = {
      crewId: crew,
      schedule,
      ...(flagValue(args, "--timezone") ? { timezone: flagValue(args, "--timezone") } : {}),
      ...(quietStart && quietEnd ? { quietHours: { start: quietStart, end: quietEnd } } : {}),
      checklist: checklistFrom(args),
      ...(flagValue(args, "--as") ? { principal: flagValue(args, "--as") } : {}),
      ...(flagValue(args, "--model") ? { model: flagValue(args, "--model") } : {}),
      ...(args.includes("--quiet-on-ok") ? { notifyOnOk: false } : {}),
      ...(args.includes("--stop-on-error") ? { stopOnError: true } : {}),
      enabled: args.includes("--enable"),
    };
    const body = await orchFetch<{ heartbeat: CrewHeartbeat }>(args, "/heartbeats", {
      method: "POST",
      body: JSON.stringify({ heartbeat }),
    });
    printHeartbeat(body.heartbeat);
    if (!body.heartbeat.enabled) {
      console.log(
        "\nStored but off. Turn it on:  lacrew heartbeat on --crew " + body.heartbeat.crewId,
      );
    }
    return;
  }

  if (sub === "on" || sub === "off") {
    if (!crew) throw new Error(`lacrew heartbeat ${sub} --crew <id>`);
    const body = await orchFetch<{ heartbeat: CrewHeartbeat }>(args, "/heartbeats/enabled", {
      method: "POST",
      body: JSON.stringify({ crewId: crew, enabled: sub === "on" }),
    });
    printHeartbeat(body.heartbeat);
    return;
  }

  if (sub === "remove") {
    if (!crew) throw new Error("lacrew heartbeat remove --crew <id>");
    const body = await orchFetch<{ removed: boolean }>(args, "/heartbeats/delete", {
      method: "POST",
      body: JSON.stringify({ crewId: crew }),
    });
    console.log(body.removed ? `Removed the heartbeat for ${crew}.` : `No heartbeat for ${crew}.`);
    return;
  }

  if (sub === "run") {
    if (!crew) throw new Error("lacrew heartbeat run --crew <id>");
    const body = await orchFetch<{ tick: Tick }>(args, "/heartbeats/run", {
      method: "POST",
      body: JSON.stringify({ crewId: crew }),
    });
    printTick(body.tick);
    console.log(
      body.tick.messageId
        ? `\nPosted to the crew thread as ${body.tick.messageId}.`
        : "\nNothing posted (notifyOnOk is off and the tick was clean).",
    );
    return;
  }

  if (sub === "ticks") {
    const limit = flagValue(args, "--limit") ?? "10";
    const query = `?limit=${encodeURIComponent(limit)}${crew ? `&crewId=${encodeURIComponent(crew)}` : ""}`;
    const body = await orchFetch<{ ticks: Tick[] }>(args, `/heartbeats/ticks${query}`);
    if (body.ticks.length === 0) {
      console.log("No tick has run yet.");
      return;
    }
    for (const tick of body.ticks) {
      console.log(`${tick.startedAt}  `);
      printTick(tick);
      console.log("");
    }
    return;
  }

  console.log(`lacrew heartbeat — a crew's standing checklist (F2.21)

  presets                            Cadences worth offering by name
  list                               Every heartbeat on this orchestrator
  show --crew <id>                   One heartbeat in full
  set --crew <id> --schedule '<cron>'
      [--flow a,b] [--skill c]       What it works through, in order
      [--timezone Europe/Paris]      Zone the schedule and quiet hours read in
      [--quiet-start 22:00 --quiet-end 07:00]
      [--as 0x…]                     Seat every item runs as
      [--model cheap/model]          Model for skill items
      [--quiet-on-ok]                Skip the note when nothing needs you
      [--stop-on-error]              Stop the tick at the first failure
      [--enable]                     Turn it on as it is saved
  on|off --crew <id>                 Enable / disable
  run --crew <id>                    Work the checklist now, off-schedule
  ticks [--crew <id>] [--limit 10]   What the last ticks did
  remove --crew <id>                 Drop the heartbeat

A heartbeat only ever runs what its checklist already names. It widens no
session scope, whitelist or cap, and every item runs as a declared seat down
the same path a manual run takes.

Env: ORCH_URL (or --url), ORCH_TOKEN`);
}
