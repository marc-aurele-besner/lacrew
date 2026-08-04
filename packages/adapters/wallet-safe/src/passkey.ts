/**
 * Passkey (WebAuthn) owners for Safe accounts (PRD F1.3).
 *
 * A passkey cannot hold an address by itself: Safe's passkey module gives the
 * credential one by deploying a `SafeWebAuthnSigner` — a small contract that
 * verifies WebAuthn P-256 signatures for exactly one (x, y, verifiers) tuple —
 * through a CREATE2 factory. The signer's address is therefore deterministic
 * in the public key, so a Safe owned by it can be predicted (and funded)
 * before either contract exists.
 *
 * Nothing here signs or broadcasts: this package holds no key material, and a
 * passkey's private half never leaves the user's authenticator anyway.
 */

import { encodeFunctionData, getAddress, parseAbi } from "viem";
import {
  getDaimoP256VerifierDeployment,
  getSafeWebAuthnSignerFactoryDeployment,
} from "@safe-global/safe-modules-deployments";
import {
  deploySafeWallet,
  predictSafeWallet,
  type SafeDeploymentTransaction,
  type SafeWallet,
} from "./safe.js";

/** Uncompressed P-256 public key coordinates, 32 bytes each. */
export type P256Coordinates = {
  x: `0x${string}`;
  y: `0x${string}`;
};

const COSE_KTY = 1;
const COSE_ALG = 3;
const COSE_EC2_CRV = -1;
const COSE_EC2_X = -2;
const COSE_EC2_Y = -3;
const KTY_EC2 = 2;
const ALG_ES256 = -7;
const CRV_P256 = 1;

type CborValue =
  number | bigint | string | Uint8Array | boolean | null | CborValue[] | Map<number, CborValue>;

/**
 * Minimal CBOR reader for the subset a COSE_Key uses (ints, byte/text
 * strings, arrays, maps, simple values). Anything outside that subset throws
 * rather than guessing — a key we cannot fully read is a key we refuse.
 */
function readCbor(buf: Uint8Array, offset: number): [CborValue, number] {
  if (offset >= buf.length) throw new Error("Truncated CBOR.");
  const initial = buf[offset]!;
  const major = initial >> 5;
  const additional = initial & 0x1f;

  let length = 0n;
  let cursor = offset + 1;
  if (additional < 24) {
    length = BigInt(additional);
  } else if (additional === 24 || additional === 25 || additional === 26) {
    const bytes = additional === 24 ? 1 : additional === 25 ? 2 : 4;
    if (cursor + bytes > buf.length) throw new Error("Truncated CBOR length.");
    for (let i = 0; i < bytes; i++) length = (length << 8n) | BigInt(buf[cursor + i]!);
    cursor += bytes;
  } else {
    throw new Error(`Unsupported CBOR additional info ${additional}.`);
  }

  switch (major) {
    case 0:
      return [length <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(length) : length, cursor];
    case 1: {
      const value = -1n - length;
      return [value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value, cursor];
    }
    case 2:
    case 3: {
      const n = Number(length);
      if (cursor + n > buf.length) throw new Error("Truncated CBOR string.");
      const slice = buf.slice(cursor, cursor + n);
      return [major === 2 ? slice : new TextDecoder().decode(slice), cursor + n];
    }
    case 4: {
      const items: CborValue[] = [];
      for (let i = 0; i < Number(length); i++) {
        const [item, next] = readCbor(buf, cursor);
        items.push(item);
        cursor = next;
      }
      return [items, cursor];
    }
    case 5: {
      const map = new Map<number, CborValue>();
      for (let i = 0; i < Number(length); i++) {
        const [key, afterKey] = readCbor(buf, cursor);
        const [value, afterValue] = readCbor(buf, afterKey);
        if (typeof key !== "number") throw new Error("Non-integer CBOR map key.");
        map.set(key, value);
        cursor = afterValue;
      }
      return [map, cursor];
    }
    case 7: {
      if (additional === 20) return [false, cursor];
      if (additional === 21) return [true, cursor];
      if (additional === 22) return [null, cursor];
      throw new Error(`Unsupported CBOR simple value ${additional}.`);
    }
    default:
      throw new Error(`Unsupported CBOR major type ${major}.`);
  }
}

function toBytes(publicKey: string | Uint8Array): Uint8Array {
  if (publicKey instanceof Uint8Array) return publicKey;
  return new Uint8Array(Buffer.from(publicKey, "base64url"));
}

function toHex32(bytes: Uint8Array, label: string): `0x${string}` {
  if (bytes.length !== 32) {
    throw new Error(`COSE ${label} coordinate is ${bytes.length} bytes, expected 32.`);
  }
  return `0x${Buffer.from(bytes).toString("hex")}` as `0x${string}`;
}

/**
 * Extract P-256 coordinates from a WebAuthn COSE public key (the blob a
 * registration ceremony's attestation carries). Strict on kind: an RSA key,
 * a foreign curve, or a non-ES256 algorithm is refused, never coerced.
 */
export function coseP256Coordinates(publicKey: string | Uint8Array): P256Coordinates {
  const bytes = toBytes(publicKey);
  const [decoded] = readCbor(bytes, 0);
  if (!(decoded instanceof Map)) throw new Error("COSE key is not a CBOR map.");
  const kty = decoded.get(COSE_KTY);
  if (kty !== KTY_EC2) throw new Error(`COSE kty ${String(kty)} is not EC2.`);
  const alg = decoded.get(COSE_ALG);
  if (alg !== undefined && alg !== ALG_ES256) {
    throw new Error(`COSE alg ${String(alg)} is not ES256.`);
  }
  const crv = decoded.get(COSE_EC2_CRV);
  if (crv !== CRV_P256) throw new Error(`COSE crv ${String(crv)} is not P-256.`);
  const x = decoded.get(COSE_EC2_X);
  const y = decoded.get(COSE_EC2_Y);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
    throw new Error("COSE key is missing x/y coordinates.");
  }
  return { x: toHex32(x, "x"), y: toHex32(y, "y") };
}

/**
 * Safe's `P256.Verifiers` packing: a 2-byte precompile address (RIP-7212,
 * zero to disable) over a 20-byte fallback verifier. The value is part of the
 * signer's CREATE2 input, so the default is fallback-only — deterministic on
 * every chain, rather than a different owner address where a precompile
 * happens to exist.
 */
export function packVerifiers(fallbackVerifier: `0x${string}`, precompile = 0): bigint {
  if (precompile < 0 || precompile > 0xffff) {
    throw new Error(`Precompile ${precompile} does not fit the 2-byte field.`);
  }
  return (BigInt(precompile) << 160n) | BigInt(getAddress(fallbackVerifier));
}

const SIGNER_FACTORY_ABI = parseAbi([
  "function getSigner(uint256 x, uint256 y, uint176 verifiers) view returns (address)",
  "function createSigner(uint256 x, uint256 y, uint176 verifiers) returns (address)",
]);

const PASSKEY_MODULE_VERSION = "0.2.1";

function deploymentAddress(
  deployment: { networkAddresses: Record<string, string | string[]> } | undefined,
  name: string,
  chainId: number,
): `0x${string}` {
  const raw = deployment?.networkAddresses[String(chainId)];
  const addr = Array.isArray(raw) ? raw[0] : raw;
  if (!addr) {
    throw new Error(`${name} has no canonical deployment on chain ${chainId}.`);
  }
  return getAddress(addr);
}

/** Canonical passkey-module addresses for a chain; throws where none exist. */
export function passkeyModuleAddresses(chainId: number): {
  signerFactory: `0x${string}`;
  p256Verifier: `0x${string}`;
} {
  return {
    signerFactory: deploymentAddress(
      getSafeWebAuthnSignerFactoryDeployment({ version: PASSKEY_MODULE_VERSION }),
      "SafeWebAuthnSignerFactory",
      chainId,
    ),
    p256Verifier: deploymentAddress(
      getDaimoP256VerifierDeployment({ version: PASSKEY_MODULE_VERSION }),
      "Daimo P-256 verifier",
      chainId,
    ),
  };
}

export type PasskeyOwner = {
  /** The SafeWebAuthnSigner address this credential owns a Safe through. */
  address: `0x${string}`;
  coordinates: P256Coordinates;
  verifiers: bigint;
  factory: `0x${string}`;
  /** True once the signer contract has code; owners work counterfactually. */
  deployed: boolean;
};

/** The viem client surface this module reads through. */
type ChainReader = {
  getChainId(): Promise<number>;
  getCode(args: { address: `0x${string}` }): Promise<string | undefined>;
  readContract(args: {
    address: `0x${string}`;
    abi: typeof SIGNER_FACTORY_ABI;
    functionName: "getSigner";
    args: readonly [bigint, bigint, bigint];
  }): Promise<`0x${string}`>;
};

/**
 * The deterministic signer address for a passkey. `getSigner` is a pure
 * CREATE2 computation on the factory, so it answers before anything deploys —
 * but it is asked of the real factory, not reimplemented here, so the answer
 * can never drift from what `createSigner` will actually do.
 */
export async function predictPasskeyOwner(
  client: ChainReader,
  publicKey: string | Uint8Array,
  opts: { precompile?: number } = {},
): Promise<PasskeyOwner> {
  const coordinates = coseP256Coordinates(publicKey);
  const chainId = await client.getChainId();
  const { signerFactory, p256Verifier } = passkeyModuleAddresses(chainId);
  const verifiers = packVerifiers(p256Verifier, opts.precompile ?? 0);
  const address = await client.readContract({
    address: signerFactory,
    abi: SIGNER_FACTORY_ABI,
    functionName: "getSigner",
    args: [BigInt(coordinates.x), BigInt(coordinates.y), verifiers],
  });
  const code = await client.getCode({ address });
  return {
    address,
    coordinates,
    verifiers,
    factory: signerFactory,
    deployed: typeof code === "string" && code !== "0x",
  };
}

/** The factory call that deploys a passkey's signer contract. */
export function buildPasskeyOwnerDeployTx(
  chainId: number,
  coordinates: P256Coordinates,
  opts: { precompile?: number } = {},
): { to: `0x${string}`; data: `0x${string}`; value: bigint } {
  const { signerFactory, p256Verifier } = passkeyModuleAddresses(chainId);
  return {
    to: signerFactory,
    data: encodeFunctionData({
      abi: SIGNER_FACTORY_ABI,
      functionName: "createSigner",
      args: [
        BigInt(coordinates.x),
        BigInt(coordinates.y),
        packVerifiers(p256Verifier, opts.precompile ?? 0),
      ],
    }),
    value: 0n,
  };
}

export type PasskeySafeOptions = {
  /** RPC URL — used both for the signer prediction and the Safe prediction. */
  provider: string;
  /** WebAuthn COSE public key (base64url or raw bytes). */
  publicKey: string | Uint8Array;
  /** Distinguishes Safes sharing a credential; see `toSaltNonce`. */
  saltNonce?: string;
  precompile?: number;
};

export type PasskeySafe = {
  safe: SafeWallet;
  owner: PasskeyOwner;
};

/**
 * The counterfactual Safe a passkey owns: credential → signer address →
 * 1-of-1 Safe. Deterministic end to end, so the org's root address exists —
 * and can receive funds — before any deployment transaction is broadcast.
 */
export async function predictPasskeySafe(
  client: ChainReader,
  opts: PasskeySafeOptions,
): Promise<PasskeySafe> {
  const owner = await predictPasskeyOwner(client, opts.publicKey, {
    ...(opts.precompile !== undefined ? { precompile: opts.precompile } : {}),
  });
  const safe = await predictSafeWallet({
    provider: opts.provider,
    owners: [owner.address],
    threshold: 1,
    ...(opts.saltNonce ? { saltNonce: opts.saltNonce } : {}),
  });
  return { safe, owner };
}

export type PasskeySafeDeployment = {
  /** Deploys the WebAuthn signer; needed before the Safe verifies a signature. */
  signerDeployTx: { to: `0x${string}`; data: `0x${string}`; value: bigint };
  /** Deploys the Safe itself at `safeAddress`. */
  safeDeployTx: SafeDeploymentTransaction;
  owner: PasskeyOwner;
};

/**
 * Both deployment transactions for a passkey-owned Safe, built and returned —
 * never broadcast, since broadcasting takes a funded sender this package
 * refuses to hold. The Safe deploy does not depend on the signer being
 * deployed first (an owner is just an address), but the signer must exist
 * before the Safe can verify its first signature.
 */
export async function deployPasskeySafe(
  client: ChainReader,
  opts: PasskeySafeOptions,
): Promise<PasskeySafeDeployment> {
  const owner = await predictPasskeyOwner(client, opts.publicKey, {
    ...(opts.precompile !== undefined ? { precompile: opts.precompile } : {}),
  });
  const chainId = await client.getChainId();
  const safeDeployTx = await deploySafeWallet({
    provider: opts.provider,
    owners: [owner.address],
    threshold: 1,
    ...(opts.saltNonce ? { saltNonce: opts.saltNonce } : {}),
  });
  return {
    signerDeployTx: buildPasskeyOwnerDeployTx(chainId, owner.coordinates, {
      ...(opts.precompile !== undefined ? { precompile: opts.precompile } : {}),
    }),
    safeDeployTx,
    owner,
  };
}
