/**
 * OrgRegistry: the org tree. Mirrors `contracts/src/OrgRegistry.sol`.
 */

import { emit } from "./frame.js";
import { SimRevert, ZERO_ADDRESS, addr, type Address } from "./types.js";
import type { Ctx } from "./world.js";

const CONTRACT = "OrgRegistry";

/** `IOrgRegistry.NodeKind`, by ABI value. */
export const NodeKind = { HumanRoot: 0, ManagerAgent: 1, WorkerAgent: 2 } as const;

export interface OrgNodeState {
  account: Address;
  kind: number;
  parent: Address;
  active: boolean;
}

export interface OrgRegistryState {
  root: Address;
  governor: Address;
  nodes: Record<Address, OrgNodeState>;
  children: Record<Address, Address[]>;
}

export function blankOrgRegistry(): OrgRegistryState {
  return { root: ZERO_ADDRESS, governor: ZERO_ADDRESS, nodes: {}, children: {} };
}

/** `_nodes[account]`: an unset slot reads as the zero struct. */
function nodeAt(state: OrgRegistryState, account: Address): OrgNodeState {
  return (
    state.nodes[account] ?? { account: ZERO_ADDRESS, kind: 0, parent: ZERO_ADDRESS, active: false }
  );
}

function childrenAt(state: OrgRegistryState, parent: Address): Address[] {
  return (state.children[parent] ??= []);
}

export function deploy(ctx: Ctx, address: Address, humanRoot_: Address): void {
  const humanRoot = addr(humanRoot_);
  if (humanRoot === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  ctx.world.addresses.orgRegistry = address;
  ctx.world.orgRegistry = {
    root: humanRoot,
    governor: ZERO_ADDRESS,
    nodes: {
      [humanRoot]: {
        account: humanRoot,
        kind: NodeKind.HumanRoot,
        parent: ZERO_ADDRESS,
        active: true,
      },
    },
    children: {},
  };
}

export function getNode(ctx: Ctx, account_: Address): OrgNodeState {
  const account = addr(account_);
  const node = nodeAt(ctx.world.orgRegistry, account);
  if (node.account === ZERO_ADDRESS) throw new SimRevert("NodeNotFound", { account });
  return { ...node };
}

export function getChildren(ctx: Ctx, parent: Address): Address[] {
  return [...(ctx.world.orgRegistry.children[addr(parent)] ?? [])];
}

export function setGovernor(ctx: Ctx, governor_: Address): void {
  const state = ctx.world.orgRegistry;
  const governor = addr(governor_);
  if (governor === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  if (state.governor !== ZERO_ADDRESS) {
    if (ctx.sender !== state.governor) throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  } else if (ctx.sender !== state.root) {
    throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  }
  state.governor = governor;
}

export function addNode(ctx: Ctx, account_: Address, kind: number, parent_: Address): void {
  const state = ctx.world.orgRegistry;
  const account = addr(account_);
  const parent = addr(parent_);
  authorize(ctx);
  if (nodeAt(state, account).account !== ZERO_ADDRESS) {
    throw new SimRevert("NodeAlreadyExists", { account });
  }
  if (nodeAt(state, parent).account === ZERO_ADDRESS) {
    throw new SimRevert("InvalidParent", { parent });
  }

  state.nodes[account] = { account, kind, parent, active: true };
  childrenAt(state, parent).push(account);
  emit(ctx, ctx.world.addresses.orgRegistry, CONTRACT, "NodeAdded", { account, kind, parent });
}

export function setActive(ctx: Ctx, account_: Address, active: boolean): void {
  const state = ctx.world.orgRegistry;
  const account = addr(account_);
  authorize(ctx);
  if (nodeAt(state, account).account === ZERO_ADDRESS) {
    throw new SimRevert("NodeNotFound", { account });
  }
  if (account === state.root) throw new SimRevert("CannotMutateRoot", { account });
  state.nodes[account]!.active = active;
  emit(ctx, ctx.world.addresses.orgRegistry, CONTRACT, "NodeActiveUpdated", { account, active });
}

export function removeNode(ctx: Ctx, account_: Address): void {
  const state = ctx.world.orgRegistry;
  const account = addr(account_);
  authorize(ctx);
  const node = nodeAt(state, account);
  if (node.account === ZERO_ADDRESS) throw new SimRevert("NodeNotFound", { account });
  if (account === state.root) throw new SimRevert("CannotMutateRoot", { account });

  const parent = node.parent;
  const kids = state.children[account] ?? [];
  for (const child of kids) {
    // `_nodes[child].parent = parent` writes the slot whether or not a node lives there.
    state.nodes[child] = { ...nodeAt(state, child), parent };
    childrenAt(state, parent).push(child);
  }
  delete state.children[account];

  removeFromParent(state, parent, account);
  delete state.nodes[account];
  emit(ctx, ctx.world.addresses.orgRegistry, CONTRACT, "NodeRemoved", {
    account,
    formerParent: parent,
  });
}

export function reparent(ctx: Ctx, account_: Address, newParent_: Address): void {
  const state = ctx.world.orgRegistry;
  const account = addr(account_);
  const newParent = addr(newParent_);
  authorize(ctx);
  const node = nodeAt(state, account);
  if (node.account === ZERO_ADDRESS) throw new SimRevert("NodeNotFound", { account });
  if (account === state.root) throw new SimRevert("CannotMutateRoot", { account });
  if (nodeAt(state, newParent).account === ZERO_ADDRESS) {
    throw new SimRevert("InvalidParent", { parent: newParent });
  }
  if (newParent === account) throw new SimRevert("CyclicParent", { account, newParent });
  if (isAncestor(state, account, newParent)) {
    throw new SimRevert("CyclicParent", { account, newParent });
  }

  const oldParent = node.parent;
  if (oldParent === newParent) return;

  removeFromParent(state, oldParent, account);
  state.nodes[account]!.parent = newParent;
  childrenAt(state, newParent).push(account);
  emit(ctx, ctx.world.addresses.orgRegistry, CONTRACT, "NodeReparented", {
    account,
    oldParent,
    newParent,
  });
}

/** True if `maybeAncestor` is on the path from `node` up to root. */
function isAncestor(state: OrgRegistryState, maybeAncestor: Address, node: Address): boolean {
  let cursor = node;
  while (cursor !== ZERO_ADDRESS) {
    if (cursor === maybeAncestor) return true;
    cursor = nodeAt(state, cursor).parent;
  }
  return false;
}

/** Swap-and-pop, so sibling order matches the contract's after a removal. */
function removeFromParent(state: OrgRegistryState, parent: Address, child: Address): void {
  const siblings = state.children[parent];
  if (!siblings) return;
  const n = siblings.length;
  for (let i = 0; i < n; i++) {
    if (siblings[i] === child) {
      siblings[i] = siblings[n - 1]!;
      siblings.pop();
      return;
    }
  }
}

function authorize(ctx: Ctx): void {
  const state = ctx.world.orgRegistry;
  if (state.governor !== ZERO_ADDRESS) {
    if (ctx.sender !== state.governor) throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  } else if (ctx.sender !== state.root) {
    throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  }
}
