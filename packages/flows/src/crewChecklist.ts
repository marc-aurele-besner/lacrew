/**
 * The golden path, derived: blueprint → funded seats → one wired connector →
 * flows installed → first run → first thread message (PRD F2.25).
 *
 * Installing a blueprint leaves an operator with a tree and no evidence the
 * crew can work. What is actually missing at that point is never the org — it
 * is a model key, a connector, flows nothing installed, and a run nobody fired.
 * Each of those is a different repair job, and an operator staring at a quiet
 * dashboard cannot tell which one they are having.
 *
 * ## Every step is derived, none is marked done
 *
 * There is no "mark complete" here and no stored progress. Each step reads a
 * fact the system already serves — whether the runtime is live, the connectors
 * it has registered, the flows saved against it, the runs recorded, the
 * messages in the thread — so the checklist cannot claim something that is not
 * true, and cannot go stale when a connector's credential is later removed. A
 * checklist with its own memory is a second source of truth about whether the
 * product works, and it would be the one that lies.
 *
 * ## Four states, and `unknown` is the load-bearing one
 *
 * `done` / `blocked` / `optional` / `unknown`. The last exists because "the
 * orchestrator did not answer, so we cannot say whether a connector is wired"
 * is a third answer. Rendering it as blocked would send an operator to fix a
 * connector that is fine; rendering it as done would tell them a crew is ready
 * when nobody knows. Both are worse than saying so.
 *
 * ## One derivation, two clients
 *
 * This lives in the public package because both a self-hosted `lacrew crews
 * checklist` and the hosted crew page have to answer the same question, and two
 * implementations of "is this crew ready" would disagree the first time one of
 * them learned something. What differs between them is where the facts come
 * from — the CLI probes an orchestrator directly, the cloud reads its own
 * control plane — and what a step offers to do about it, which is why the
 * repair links are the caller's and not part of a step here.
 */

export type CrewCheckState = "done" | "blocked" | "optional" | "unknown";

export type CrewCheckId =
  | "seats"
  | "orchestrator"
  | "model"
  | "connector"
  | "flows"
  | "run"
  | "thread";

export type CrewCheck = {
  id: CrewCheckId;
  /** Short noun phrase — "Model provider", "Connector". */
  title: string;
  /** What is true right now, in one line. */
  detail: string;
  state: CrewCheckState;
  /**
   * The subject the repair concerns, when the step has one: the connector id a
   * caller should link to. Absent when the repair is not about a named thing.
   */
  subject?: string;
};

/**
 * What the checklist reads. Every field that can fail to load is nullable, and
 * null means "could not read" rather than "none" — the distinction the whole
 * module turns on.
 */
export type CrewChecklistFacts = {
  /** Seats on this crew's chart, and how many hold an account the chain minted. */
  seats: { total: number; withAccount: number };
  /** Whether the runtime is serving live runs, and its own words when it is not. */
  runtime: { live: boolean; detail?: string } | null;
  /** Whether a model provider key resolves. Null when the report could not be read. */
  model: { configured: boolean } | null;
  /** Connectors the orchestrator has registered, with whether their credentials resolve. */
  connectors: readonly { id: string; ready: boolean }[] | null;
  /** Flow definition ids saved against this workspace. */
  installedFlows: readonly string[] | null;
  /** Flow definition ids the blueprint ships. Empty when it ships none. */
  blueprintFlows: readonly string[];
  /** Runs recorded for this workspace. */
  runs: number | null;
  /** Messages in this crew's thread. */
  threadMessages: number | null;
  /** The blueprint's certified sample run, when one ships. */
  sample: {
    flow: string;
    needs: { model: boolean; connectors: readonly string[] };
  } | null;
  /**
   * Whether a blueprint backs this crew at all. Omitted reads as `true`.
   *
   * A crew built by hand still deserves the list — its seats, its runtime and
   * its model key are exactly as checkable — but it has no certified flow and
   * no certified input, and the copy has to say that rather than report a
   * blueprint that ships nothing.
   */
  blueprint?: boolean;
};

function seatsStep(facts: CrewChecklistFacts): CrewCheck {
  const { total, withAccount } = facts.seats;
  if (total === 0) {
    return {
      id: "seats",
      title: "Seats",
      detail: "This crew has no seats yet.",
      state: "blocked",
    };
  }
  if (withAccount === 0) {
    return {
      id: "seats",
      title: "Seats",
      detail:
        total === 1
          ? "The one hire is still a governance proposal, so no account exists to run as."
          : `All ${total} hires are still governance proposals, so no account exists to run as.`,
      state: "blocked",
    };
  }
  if (withAccount < total) {
    return {
      id: "seats",
      title: "Seats",
      // Not blocked: a crew can do useful work while a seat is still queued,
      // and calling this a blocker would stop a run the chain would allow.
      detail: `${withAccount} of ${total} seats have an account; the rest are still proposals.`,
      state: "done",
    };
  }
  return {
    id: "seats",
    title: "Seats",
    detail: total === 1 ? "The seat holds an account." : `All ${total} seats hold accounts.`,
    state: "done",
  };
}

function orchestratorStep(facts: CrewChecklistFacts): CrewCheck {
  if (!facts.runtime) {
    return {
      id: "orchestrator",
      title: "Orchestrator",
      detail: "The status report could not be read, so nothing can be said about the runtime.",
      state: "unknown",
    };
  }
  if (facts.runtime.live) {
    return {
      id: "orchestrator",
      title: "Orchestrator",
      detail: "Running against a chain.",
      state: "done",
    };
  }
  return {
    id: "orchestrator",
    title: "Orchestrator",
    // The status surface already writes one honest sentence per verdict; a
    // second one written here would be free to disagree with it.
    detail: facts.runtime.detail ?? "The orchestrator is not serving live runs.",
    state: "blocked",
  };
}

function modelStep(facts: CrewChecklistFacts): CrewCheck {
  const wanted = facts.sample?.needs.model ?? true;
  if (!wanted) {
    return {
      id: "model",
      title: "Model provider",
      detail: "This crew's first run makes no model call.",
      state: "optional",
    };
  }
  if (!facts.model) {
    return {
      id: "model",
      title: "Model provider",
      detail: "The status report could not be read, so the model provider is unknown.",
      state: "unknown",
    };
  }
  if (facts.model.configured) {
    return {
      id: "model",
      title: "Model provider",
      detail: "A model key is configured, so completions are real model output.",
      state: "done",
    };
  }
  return {
    id: "model",
    title: "Model provider",
    detail:
      "No model key, so every completion returns a local stub. A classifier reading stub text falls through to its default branch, so the run would finish and mean nothing.",
    state: "blocked",
  };
}

/**
 * The connectors this crew's first run actually calls.
 *
 * Read off the sample's flow rather than the blueprint's whole declaration:
 * a blueprint may name surfaces the operator wires later to close a loop no
 * shipped flow closes, and blocking the first run on one of those would send
 * someone to register a credential nothing is about to use.
 */
function connectorStep(facts: CrewChecklistFacts): CrewCheck {
  const wanted = facts.sample?.needs.connectors ?? [];
  if (wanted.length === 0) {
    return {
      id: "connector",
      title: "Connector",
      detail: "This crew's first run does not leave LaCrew.",
      state: "optional",
    };
  }
  const named = wanted.join(", ");
  if (!facts.connectors) {
    return {
      id: "connector",
      title: "Connector",
      detail: `The orchestrator's connectors could not be read, so it is unknown whether ${named} is registered.`,
      state: "unknown",
      subject: wanted[0]!,
    };
  }
  const missing = wanted.filter((id) => !facts.connectors!.some((c) => c.id === id));
  if (missing.length > 0) {
    return {
      id: "connector",
      title: "Connector",
      detail: `${missing.join(", ")} is not registered on the orchestrator, so the first step of the run resolves to nothing.`,
      state: "blocked",
      subject: missing[0]!,
    };
  }
  // Registered but the credential's environment variables do not resolve. The
  // call reaches the network and comes back 401, which reads as a broken
  // product rather than an unset variable, so it is a blocker of its own.
  const unready = wanted.filter((id) => facts.connectors!.some((c) => c.id === id && !c.ready));
  if (unready.length > 0) {
    return {
      id: "connector",
      title: "Connector",
      detail: `${unready.join(", ")} is registered but its credential is not set, so calls would come back unauthorized.`,
      state: "blocked",
      subject: unready[0]!,
    };
  }
  return {
    id: "connector",
    title: "Connector",
    detail: `${named} is registered and credentialed.`,
    state: "done",
  };
}

function flowsStep(facts: CrewChecklistFacts): CrewCheck {
  if (facts.blueprintFlows.length === 0) {
    return {
      id: "flows",
      title: "Flows",
      detail:
        facts.blueprint === false
          ? "This crew came from no blueprint, so nothing ships flows to install — the flows it runs are the ones you write."
          : "This blueprint ships no flows.",
      state: "optional",
    };
  }
  if (!facts.installedFlows) {
    return {
      id: "flows",
      title: "Flows",
      detail: "The workspace's flows could not be read.",
      state: "unknown",
    };
  }
  const installed = facts.blueprintFlows.filter((id) => facts.installedFlows!.includes(id));
  if (installed.length === facts.blueprintFlows.length) {
    return {
      id: "flows",
      title: "Flows",
      detail:
        facts.blueprintFlows.length === 1
          ? "The blueprint's flow is installed."
          : `All ${facts.blueprintFlows.length} of the blueprint's flows are installed.`,
      state: "done",
    };
  }
  /*
    A flow binds `{{crew.<role>}}` to the address the hire landed on, so it
    cannot be installed before the seats exist — `bindCrewFlow` throws rather
    than render a delegate as an empty string. Saying which of the two is
    actually outstanding is the difference between a button that works and one
    that fails with a stack trace.
  */
  const blockedOnSeats = facts.seats.withAccount === 0;
  const count = `${installed.length} of ${facts.blueprintFlows.length} installed`;
  return {
    id: "flows",
    title: "Flows",
    detail: blockedOnSeats
      ? `${count}. Flows bind to seat addresses, so they cannot be installed until at least one hire has executed.`
      : `${count}. Install flows binds the rest to the seats and to the addresses this crew spends against.`,
    state: "blocked",
  };
}

function runStep(facts: CrewChecklistFacts): CrewCheck {
  if (facts.runs == null) {
    return {
      id: "run",
      title: "First run",
      detail: "The workspace's run history could not be read.",
      state: "unknown",
    };
  }
  if (facts.runs > 0) {
    return {
      id: "run",
      title: "First run",
      detail: facts.runs === 1 ? "One flow run recorded." : `${facts.runs} flow runs recorded.`,
      state: "done",
    };
  }
  return {
    id: "run",
    title: "First run",
    detail: facts.sample
      ? "Nothing has run yet. The sample fires the blueprint's certified flow against the live runtime."
      : facts.blueprint === false
        ? "Nothing has run yet, and a crew built by hand ships no certified sample — choose a flow and an input."
        : "Nothing has run yet, and this blueprint ships no certified sample — choose a flow and an input.",
    state: "blocked",
  };
}

function threadStep(facts: CrewChecklistFacts): CrewCheck {
  if (facts.threadMessages == null) {
    return {
      id: "thread",
      title: "Thread",
      detail: "The crew thread could not be read.",
      state: "unknown",
    };
  }
  if (facts.threadMessages > 0) {
    return {
      id: "thread",
      title: "Thread",
      detail:
        facts.threadMessages === 1
          ? "One message in the crew thread."
          : `${facts.threadMessages} messages in the crew thread.`,
      state: "done",
    };
  }
  return {
    id: "thread",
    title: "Thread",
    detail: "The crew has said nothing yet. A run writes its plan, result or question here.",
    state: "blocked",
  };
}

/** The checklist, in the order the work has to happen. */
export function crewChecklist(facts: CrewChecklistFacts): CrewCheck[] {
  return [
    seatsStep(facts),
    orchestratorStep(facts),
    modelStep(facts),
    connectorStep(facts),
    flowsStep(facts),
    runStep(facts),
    threadStep(facts),
  ];
}

/**
 * The first step that stops a run happening, or null when none does.
 *
 * `run` and `thread` are excluded: they are the *outcome* the checklist is
 * driving at, so treating "nothing has run yet" as a reason not to run would
 * refuse every first run there has ever been. `unknown` does not block either —
 * refusing on an unreadable status report would make a flaky probe into an
 * outage, and the run itself is the better test of whether things work.
 */
export function crewChecklistBlocker(steps: readonly CrewCheck[]): CrewCheck | null {
  return steps.find((s) => s.state === "blocked" && s.id !== "run" && s.id !== "thread") ?? null;
}

/** Every step that has to hold, holds. `optional` counts as satisfied; `unknown` does not. */
export function crewChecklistComplete(steps: readonly CrewCheck[]): boolean {
  return steps.length > 0 && steps.every((s) => s.state === "done" || s.state === "optional");
}

/** `3 of 7`, for a collapsed header. Optional steps count toward both sides. */
export function crewChecklistProgress(steps: readonly CrewCheck[]): {
  done: number;
  total: number;
} {
  return {
    done: steps.filter((s) => s.state === "done" || s.state === "optional").length,
    total: steps.length,
  };
}

/**
 * Why the sample run will not fire, in the operator's terms — or null when it
 * will. The sentence names the first blocker, because a refusal listing four
 * problems is a refusal nobody acts on.
 */
export function crewSampleRefusal(steps: readonly CrewCheck[]): string | null {
  const blocker = crewChecklistBlocker(steps);
  if (!blocker) return null;
  return `${blocker.title}: ${blocker.detail}`;
}
