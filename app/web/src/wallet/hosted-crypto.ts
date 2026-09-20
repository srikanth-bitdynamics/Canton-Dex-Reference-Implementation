import { computeMultiHashForTopology, computeSha256CantonHash, decodePreparedTransaction, hashPreparedTransaction } from "@canton-network/core-tx-visualizer";
import type { PreparedSubmission } from "./sequential-submit";

export const from64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const to64 = (b: Uint8Array<ArrayBuffer>): string => btoa(String.fromCharCode(...b));
export const hex = (b: Uint8Array): string => Array.from(b, c => c.toString(16).padStart(2, "0")).join("");
export const sha256 = async (s: string): Promise<string> => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
export const sign = async (key: CryptoKey, b: Uint8Array<ArrayBuffer>): Promise<string> => to64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, b)));

export interface KeyVault {
  version: 1;
  origin: string;
  network: string;
  publicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}
async function vaultKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function vaultBinding(v: Pick<KeyVault, "origin" | "network" | "publicKey">): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([1, v.origin, v.network, v.publicKey]));
}
export async function createVault(password: string, origin: string, network: string): Promise<KeyVault> {
  if (password.length < 16) throw new Error("Use a passphrase of at least 16 characters.");
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const publicKey = to64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const plaintext = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const header = { version: 1 as const, origin, network, publicKey };
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: vaultBinding(header) }, await vaultKey(password, salt), plaintext);
    return { ...header, salt: to64(salt), iv: to64(iv), ciphertext: to64(new Uint8Array(ciphertext)) };
  } finally { plaintext.fill(0); }
}
export async function unlockVault(v: KeyVault, password: string, origin: string, network: string): Promise<CryptoKey> {
  if (v.version !== 1 || v.origin !== origin || v.network !== network || from64(v.publicKey).length !== 32 || from64(v.salt).length !== 16 || from64(v.iv).length !== 12 || v.ciphertext.length > 4096) {
    throw new Error("This backup is invalid or belongs to another site or network.");
  }
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: from64(v.iv), additionalData: vaultBinding(v) }, await vaultKey(password, from64(v.salt)), from64(v.ciphertext)));
  try {
    const key = await crypto.subtle.importKey("pkcs8", plaintext, "Ed25519", false, ["sign"]);
    const publicKey = await crypto.subtle.importKey("raw", from64(v.publicKey), "Ed25519", false, ["verify"]);
    const proof = crypto.getRandomValues(new Uint8Array(32));
    if (!await crypto.subtle.verify("Ed25519", publicKey, from64(await sign(key, proof)), proof)) throw new Error("Backup public key does not match private key.");
    return key;
  } finally { plaintext.fill(0); }
}

type Fields = Map<number, Uint8Array<ArrayBuffer> | number>;
function fields(b: Uint8Array<ArrayBuffer>, allowed: number[]): Fields {
  let pos = 0;
  const readInt = (): number => {
    let value = 0, shift = 0;
    while (pos < b.length && shift <= 28) {
      const n = b[pos++]; value += (n & 127) * 2 ** shift;
      if (!(n & 128)) return value;
      shift += 7;
    }
    throw new Error("Invalid topology encoding");
  };
  const out: Fields = new Map();
  while (pos < b.length) {
    const tag = readInt(), field = Math.floor(tag / 8), wire = tag & 7;
    if (!allowed.includes(field) || out.has(field)) throw new Error("Unsupported topology field or repeated authority");
    if (wire === 0) out.set(field, readInt());
    else if (wire === 2) {
      const len = readInt();
      if (pos + len > b.length) throw new Error("Truncated topology");
      out.set(field, b.slice(pos, pos + len)); pos += len;
    } else throw new Error("Unsupported topology encoding");
  }
  return out;
}
function data(f: Fields, n: number): Uint8Array<ArrayBuffer> {
  const b = f.get(n);
  if (!(b instanceof Uint8Array)) throw new Error("Missing topology field");
  return b;
}
const text = (f: Fields, n: number): string => new TextDecoder("utf-8", { fatal: true }).decode(data(f, n));
function requireTrue(ok: boolean, message: string): asserts ok { if (!ok) throw new Error(message); }

export interface HostedConfig { origin: string; network: string; synchronizerId: string; participantId: string }
export interface Topology { partyId: string; publicKeyFingerprint: string; multiHash: string; topologyTransactions: string[]; allocated?: boolean }

export async function verifyTopology(t: Topology, publicKey: string, cfg: HostedConfig): Promise<void> {
  requireTrue(t.topologyTransactions.length === 1 && t.partyId.endsWith(`::${t.publicKeyFingerprint}`), "Unsupported party topology");
  const encoded = from64(t.topologyTransactions[0]);
  const wrapper = fields(encoded, [1, 2]);
  requireTrue(wrapper.get(2) === 30, "Unsupported topology version");
  const tx = fields(data(wrapper, 1), [1, 2, 3]);
  requireTrue(tx.get(1) === 1 && tx.get(2) === 1, "Only initial external-party onboarding is supported");
  const mapping = fields(data(tx, 3), [9]);
  const party = fields(data(mapping, 9), [1, 2, 3, 6]);
  requireTrue(text(party, 1) === t.partyId && party.get(2) === 1, "Party or threshold mismatch");
  const host = fields(data(party, 3), [1, 2]);
  requireTrue(text(host, 1) === cfg.participantId && host.get(2) === 2, "Participant must only confirm user-signed transactions");
  const signing = fields(data(party, 6), [1, 2]);
  requireTrue(signing.get(2) === 1, "Unexpected signing threshold");
  const key = fields(data(signing, 1), [2, 3, 5, 6]);
  const der = `302a300506032b6570032100${hex(from64(publicKey))}`;
  requireTrue(key.get(2) === 4 && key.get(6) === 1 && hex(data(key, 3)) === der, "Topology does not use your signing key");
  requireTrue(hex(data(key, 5)) === "010504", "Unsupported signing key usage");
  const hashes = await Promise.all(t.topologyTransactions.map(s => computeSha256CantonHash(11, from64(s))));
  const combined = await computeSha256CantonHash(55, await computeMultiHashForTopology(hashes));
  requireTrue(hex(combined) === hex(from64(t.multiHash)), "Topology hash mismatch");
}

const RECORDS = [
  ["settlement", "allocation", "requestedAt", "inputHoldingCids", "extraArgs", "actors"],
  ["executors", "id", "cid", "meta"],
  ["admin", "authorizer", "transferLegSides", "settlementDeadline", "nextIterationFunding", "committed", "meta"],
  ["owner", "provider", "id"],
  ["transferLegId", "side", "otherside", "amount", "instrumentId", "meta"],
  ["context", "meta"], ["values"], ["admin", "id"],
  ["operator", "trader", "baseInstrumentId", "quoteInstrumentId", "side", "limitPrice", "quantity", "expiry"],
];
type WireValue = { sum: { oneofKind: string; [key: string]: unknown } };
function equalValue(value: WireValue | undefined, expected: unknown): boolean {
  if (!value) return false;
  const kind = value.sum.oneofKind;
  const v = value.sum[kind] as any;
  switch (kind) {
    case "record": {
      if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
      const e = expected as Record<string, unknown>;
      const order = RECORDS.find(keys => keys.length === Object.keys(e).length && keys.every(k => k in e));
      return !!order && v.fields.length <= order.length && order.every((k, i) => i < v.fields.length ? equalValue(v.fields[i].value, e[k]) : e[k] === null);
    }
    case "list": return Array.isArray(expected) && v.elements.length === expected.length && expected.every((x, i) => equalValue(v.elements[i], x));
    case "optional": return v.value ? equalValue(v.value, expected) : expected === null;
    case "textMap": {
      if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
      const e = expected as Record<string, unknown>;
      return v.entries.length === Object.keys(e).length && new Set(v.entries.map((entry: any) => entry.key)).size === v.entries.length && v.entries.every((entry: any) => Object.prototype.hasOwnProperty.call(e, entry.key) && equalValue(entry.value, e[entry.key]));
    }
    case "variant": return typeof expected === "string" ? v.constructor === expected && v.value?.sum.oneofKind === "unit" :
      !!expected && typeof expected === "object" && v.constructor === (expected as any).tag && equalValue(v.value, (expected as any).value);
    case "enum": return v.constructor === expected;
    case "unit": return !!expected && typeof expected === "object" && Object.keys(expected).length === 0;
    case "numeric": return typeof expected === "string" && /^-?\d+(\.\d+)?$/.test(expected) &&
      v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") === expected.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    case "timestamp": return typeof expected === "string" && BigInt(v) === BigInt(Date.parse(expected)) * 1000n;
    case "int64": return String(v) === String(expected);
    case "text": case "party": case "contractId": case "bool": return v === expected;
    default: return false;
  }
}

export async function verifyPrepared(prepared: { preparedTransaction: string; preparedTransactionHash: string; hashingSchemeVersion: string }, expected: PreparedSubmission, cfg: HostedConfig): Promise<string> {
  requireTrue(prepared.hashingSchemeVersion === "HASHING_SCHEME_VERSION_V2", "Unsupported transaction hash version");
  const tx = decodePreparedTransaction(prepared.preparedTransaction);
  requireTrue(await hashPreparedTransaction(tx) === prepared.preparedTransactionHash, "Prepared transaction hash mismatch");
  const logicalSynchronizer = (id: string): string => id.replace(/::\d+-\d+$/, "");
  requireTrue(!!tx.metadata && logicalSynchronizer(tx.metadata.synchronizerId) === logicalSynchronizer(cfg.synchronizerId) && JSON.stringify(tx.metadata.submitterInfo?.actAs) === JSON.stringify(expected.actAs) && tx.metadata.submitterInfo?.commandId === expected.commandId, "Transaction network, command or signing party mismatch");
  requireTrue(tx.transaction?.roots.length === 1 && expected.commands.length === 1, "Unexpected transaction roots");
  const root = tx.transaction.nodes.find(n => n.nodeId === tx.transaction!.roots[0]);
  requireTrue(root?.versionedNode.oneofKind === "v1", "Unsupported transaction node version");
  const node = root.versionedNode.v1.nodeType;
  const command = expected.commands[0];
  if ("ExerciseCommand" in command) {
    const exercise = command.ExerciseCommand;
    requireTrue(node.oneofKind === "exercise" && node.exercise.contractId === exercise.contractId && node.exercise.choiceId === exercise.choice && equalValue(node.exercise.chosenValue as WireValue, exercise.choiceArgument), "Prepared allocation differs from the requested transaction");
  } else if ("CreateCommand" in command) {
    const packageId = command.CreateCommand.templateId.split(":")[0];
    requireTrue(node.oneofKind === "create" && (packageId.startsWith("#") ? node.create.packageName === packageId.slice(1) : node.create.templateId?.packageId === packageId) && command.CreateCommand.templateId.endsWith(`:${node.create.templateId?.moduleName}:${node.create.templateId?.entityName}`) && equalValue(node.create.argument as WireValue, command.CreateCommand.createArguments), "Prepared order differs from the requested transaction");
  } else throw new Error("Unsupported hosted wallet command");
  return JSON.stringify(tx, (k, v) => typeof v === "bigint" ? v.toString() : k === "label" ? undefined : v, 2);
}
