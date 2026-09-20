import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import type { Db } from "../indexer/db.js";
import { signHs256 } from "../session/index.js";

type Json = Record<string, unknown>;
type LedgerCall = (path: string, body?: unknown, admin?: boolean) => Promise<Json>;

export interface HostedWalletConfig {
  db: Db;
  origin: string;
  network: string;
  synchronizerId: string;
  participantId: string;
  ledgerUserId: string;
  callerJwtSecret: string;
  callerJwtAudience?: string;
  ledger: LedgerCall;
  now?: () => number;
}

export class HostedWalletError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function fail(status: number, message: string): never { throw new HostedWalletError(status, message); }
function str(o: Json, key: string): string {
  const value = o[key];
  if (typeof value !== "string" || !value || value.length > 100_000) fail(400, `invalid ${key}`);
  return value;
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "expected object");
  return value as Json;
}
function bytes(value: string, size: number): Buffer {
  const b = Buffer.from(value, "base64");
  if (b.length !== size || b.toString("base64") !== value) fail(400, "invalid base64 key or signature");
  return b;
}
const digest = (s: string): string => createHash("sha256").update(s).digest("hex");
const ACTIONS = new Set(["topology", "allocate", "session", "prepare", "execute", "holdings"]);

interface Account { publicKey: string; party: string; fingerprint: string; topology: string; allocated: number }

export class HostedWalletService {
  private readonly now: () => number;
  private lastLimitSweep = -1;
  constructor(private readonly cfg: HostedWalletConfig) {
    if (!cfg.callerJwtSecret || !cfg.synchronizerId || !cfg.participantId || !cfg.ledgerUserId) {
      throw new Error("hosted wallet requires caller authentication and explicit participant configuration");
    }
    if (new URL(cfg.origin).origin !== cfg.origin) throw new Error("hosted wallet origin must be an exact origin");
    this.now = cfg.now ?? Date.now;
    cfg.db.exec(`
      CREATE TABLE IF NOT EXISTS hosted_wallet_accounts (
        publicKey TEXT PRIMARY KEY, party TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
        topology TEXT NOT NULL, allocated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS hosted_wallet_challenges (
        nonce TEXT PRIMARY KEY, publicKey TEXT NOT NULL, action TEXT NOT NULL,
        payloadHash TEXT NOT NULL, message TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hosted_wallet_limits (
        bucket TEXT PRIMARY KEY, count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hosted_wallet_prepared (
        id TEXT PRIMARY KEY, publicKey TEXT NOT NULL, payload TEXT NOT NULL,
        expires INTEGER NOT NULL, result TEXT
      );
    `);
  }

  config(): Json {
    return { network: this.cfg.network, origin: this.cfg.origin,
      synchronizerId: this.cfg.synchronizerId, participantId: this.cfg.participantId };
  }

  private limit(bucket: string, maximum: number): void {
    const day = Math.floor(this.now() / 86_400_000);
    if (day !== this.lastLimitSweep) {
      this.cfg.db.prepare("DELETE FROM hosted_wallet_limits WHERE CAST(substr(bucket, 1, instr(bucket, ':') - 1) AS INTEGER) < ?").run(day - 1);
      this.lastLimitSweep = day;
    }
    const key = `${day}:${bucket}`;
    this.cfg.db.transaction(() => {
      const row = this.cfg.db.prepare("SELECT count FROM hosted_wallet_limits WHERE bucket = ?").get(key) as { count: number } | undefined;
      if ((row?.count ?? 0) >= maximum) fail(429, "hosted wallet daily limit reached");
      this.cfg.db.prepare("INSERT INTO hosted_wallet_limits VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET count=count+1").run(key);
    })();
  }

  challenge(body: Json, ip: string): Json {
    this.limit(`challenge:${ip}`, 2000);
    this.limit("challenge:global", 20_000);
    const publicKey = str(body, "publicKey");
    bytes(publicKey, 32);
    const action = str(body, "action");
    if (!ACTIONS.has(action)) fail(400, "unsupported hosted wallet action");
    const payloadHash = str(body, "payloadHash");
    if (!/^[a-f0-9]{64}$/.test(payloadHash)) fail(400, "invalid payload hash");
    const nonce = randomUUID();
    const expires = this.now() + 120_000;
    const message = JSON.stringify({ purpose: "Canton DEX hosted wallet request", ...this.config(), publicKey, action, payloadHash, nonce, expires });
    this.cfg.db.prepare("DELETE FROM hosted_wallet_challenges WHERE expires < ?").run(this.now());
    this.cfg.db.prepare("INSERT INTO hosted_wallet_challenges VALUES (?, ?, ?, ?, ?, ?)").run(nonce, publicKey, action, payloadHash, message, expires);
    return { nonce, message, expires };
  }

  private authenticate(action: string, body: Json): { publicKey: string; payload: Json } {
    const nonce = str(body, "nonce");
    const row = this.cfg.db.prepare("SELECT * FROM hosted_wallet_challenges WHERE nonce = ?").get(nonce) as
      { publicKey: string; action: string; payloadHash: string; message: string; expires: number } | undefined;
    if (!row || row.expires < this.now() || row.action !== action) fail(401, "invalid or expired request challenge");
    const payload = object(body.payload);
    if (digest(JSON.stringify(payload)) !== row.payloadHash) fail(401, "request payload changed after challenge");
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes(row.publicKey, 32)]), type: "spki", format: "der" });
    if (!verify(null, Buffer.from(row.message), key, bytes(str(body, "signature"), 64))) fail(401, "invalid request signature");
    const consumed = this.cfg.db.prepare("DELETE FROM hosted_wallet_challenges WHERE nonce = ?").run(nonce);
    if (consumed.changes !== 1) fail(401, "request challenge already used");
    return { publicKey: row.publicKey, payload };
  }

  async request(action: string, body: Json, ip: string): Promise<Json> {
    if (!ACTIONS.has(action)) fail(404, "unknown hosted wallet action");
    this.limit(`request:${ip}`, 3000);
    this.limit("request:global", 100_000);
    const { publicKey, payload } = this.authenticate(action, body);
    this.limit(`key:${publicKey}`, 1000);
    let account = this.cfg.db.prepare("SELECT * FROM hosted_wallet_accounts WHERE publicKey = ?").get(publicKey) as Account | undefined;
    if (action === "topology") {
      if (account) return { ...JSON.parse(account.topology), allocated: account.allocated === 1 };
      this.limit(`onboarding:${ip}`, 3);
      this.limit("onboarding:global", 200);
      const generated = await this.cfg.ledger("/v2/parties/external/generate-topology", {
        synchronizer: this.cfg.synchronizerId,
        partyHint: `dex-user-${digest(publicKey).slice(0, 20)}`,
        publicKey: { format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO",
          keyData: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes(publicKey, 32)]).toString("base64"),
          keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519" },
        localParticipantObservationOnly: false, otherConfirmingParticipantUids: [],
        observingParticipantUids: [], confirmationThreshold: 1,
      }, true);
      const party = str(generated, "partyId");
      const fingerprint = str(generated, "publicKeyFingerprint");
      if (!party.endsWith(`::${fingerprint}`) || !Array.isArray(generated.topologyTransactions)) fail(502, "invalid generated topology");
      this.cfg.db.prepare("INSERT OR IGNORE INTO hosted_wallet_accounts (publicKey, party, fingerprint, topology) VALUES (?, ?, ?, ?)").run(publicKey, party, fingerprint, JSON.stringify(generated));
      account = this.cfg.db.prepare("SELECT * FROM hosted_wallet_accounts WHERE publicKey = ?").get(publicKey) as Account;
      return { ...JSON.parse(account.topology), allocated: account.allocated === 1 };
    }
    if (!account) fail(401, "create external party topology first");
    if (action === "allocate") {
      if (account.allocated !== 1) {
        const topology = JSON.parse(account.topology) as { multiHash: string; topologyTransactions: string[] };
        const signature = str(payload, "topologySignature");
        const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes(publicKey, 32)]), type: "spki", format: "der" });
        if (!verify(null, Buffer.from(topology.multiHash, "base64"), key, bytes(signature, 64))) fail(401, "invalid topology signature");
        if (account.allocated === 0) {
          await this.cfg.ledger("/v2/parties/external/allocate", {
          synchronizer: this.cfg.synchronizerId,
          onboardingTransactions: topology.topologyTransactions.map(transaction => ({ transaction, signatures: [] })),
          multiHashSignatures: [{ format: "SIGNATURE_FORMAT_CONCAT", signature, signedBy: account.fingerprint, signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }],
          }, true);
          this.cfg.db.prepare("UPDATE hosted_wallet_accounts SET allocated = 2 WHERE publicKey = ?").run(publicKey);
        }
        await this.cfg.ledger(`/v2/users/${encodeURIComponent(this.cfg.ledgerUserId)}/rights`, {
          userId: this.cfg.ledgerUserId,
          rights: ["CanReadAs", "CanExecuteAs"].map(right => ({ kind: { [right]: { value: { party: account!.party } } } })),
        }, true);
        this.cfg.db.prepare("UPDATE hosted_wallet_accounts SET allocated = 1 WHERE publicKey = ?").run(publicKey);
      }
      return { party: account.party };
    }
    if (account.allocated !== 1) fail(403, "external party is not allocated");
    if (payload.party !== undefined && payload.party !== account.party) fail(403, "caller may only use its own party");
    if (action === "session") {
      const now = Math.floor(this.now() / 1000);
      return { party: account.party, callerToken: signHs256({ sub: account.party, iat: now, exp: now + 3600,
        ...(this.cfg.callerJwtAudience ? { aud: this.cfg.callerJwtAudience } : {}) }, this.cfg.callerJwtSecret) };
    }
    if (action === "holdings") {
      const cumulative = payload.filters;
      if (!Array.isArray(cumulative) || cumulative.length > 5) fail(400, "invalid holding filters");
      const end = await this.cfg.ledger("/v2/state/ledger-end");
      return this.cfg.ledger("/v2/state/active-contracts", {
        activeAtOffset: end.offset,
        filter: { filtersByParty: { [account.party]: { cumulative } } }, verbose: true,
      });
    }
    if (action === "prepare") {
      const commands = payload.commands;
      if (!Array.isArray(commands) || commands.length !== 1) fail(400, "prepare requires one command");
      const command = object(commands[0]);
      const exercise = command.ExerciseCommand ? object(command.ExerciseCommand) : undefined;
      const create = command.CreateCommand ? object(command.CreateCommand) : undefined;
      if (Object.keys(command).length !== 1 || !(exercise && exercise.choice === "AllocationFactory_Allocate") &&
          !(create && str(create, "templateId").endsWith(":CantonDex.Dex.OrderFundingRequest:OrderFundingRequest"))) {
        fail(400, "unsupported wallet command");
      }
      const id = randomUUID();
      const prepared = await this.cfg.ledger("/v2/interactive-submission/prepare", {
        commands, commandId: str(payload, "commandId"), actAs: [account.party], readAs: [],
        userId: this.cfg.ledgerUserId, synchronizerId: this.cfg.synchronizerId,
        disclosedContracts: payload.disclosedContracts ?? [],
        packageIdSelectionPreference: [], prefetchContractKeys: [], verboseHashing: false,
        hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
      });
      if (prepared.hashingSchemeVersion !== "HASHING_SCHEME_VERSION_V2") fail(502, "unsupported transaction hash version");
      this.cfg.db.prepare("DELETE FROM hosted_wallet_prepared WHERE expires < ?").run(this.now() - 86_400_000);
      this.cfg.db.prepare("INSERT INTO hosted_wallet_prepared VALUES (?, ?, ?, ?, NULL)").run(id, publicKey, JSON.stringify(prepared), this.now() + 120_000);
      return { id, ...prepared };
    }
    if (action === "execute") {
      const row = this.cfg.db.prepare("SELECT * FROM hosted_wallet_prepared WHERE id = ? AND publicKey = ?").get(str(payload, "id"), publicKey) as
        { id: string; payload: string; expires: number; result: string | null } | undefined;
      if (!row) fail(404, "prepared transaction not found for this key");
      if (row.result) return JSON.parse(row.result) as Json;
      if (row.expires < this.now()) fail(410, "prepared transaction expired; prepare and review again");
      const prepared = JSON.parse(row.payload) as Json;
      const signature = str(payload, "transactionSignature");
      const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes(publicKey, 32)]), type: "spki", format: "der" });
      if (!verify(null, Buffer.from(str(prepared, "preparedTransactionHash"), "base64"), key, bytes(signature, 64))) fail(401, "invalid transaction signature");
      const result = await this.cfg.ledger("/v2/interactive-submission/executeAndWaitForTransaction", {
        preparedTransaction: prepared.preparedTransaction, hashingSchemeVersion: prepared.hashingSchemeVersion,
        submissionId: randomUUID(), userId: this.cfg.ledgerUserId,
        deduplicationPeriod: { DeduplicationDuration: { value: { seconds: 600, nanos: 0 } } },
        partySignatures: { signatures: [{ party: account.party,
          signatures: [{ format: "SIGNATURE_FORMAT_CONCAT", signature, signedBy: account.fingerprint, signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] }] },
      });
      this.cfg.db.prepare("UPDATE hosted_wallet_prepared SET result = ? WHERE id = ?").run(JSON.stringify(result), row.id);
      return result;
    }
    return fail(404, "unknown action");
  }
}

export function hostedLedgerClient(baseUrl: string, token: string, adminToken: string): LedgerCall {
  return async (path, body, admin = false) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin ? adminToken : token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) fail(502, `participant ${res.status}: ${text.slice(0, 2000)}`);
    return JSON.parse(text) as Json;
  };
}

export async function verifyHostedLedgerAccess(baseUrl: string, userId: string, token: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/v2/users/${encodeURIComponent(userId)}/rights`;
  const anonymous = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  await anonymous.body?.cancel();
  if (anonymous.status !== 401 && anonymous.status !== 403) {
    throw new Error("hosted wallet requires authenticated Ledger API access; anonymous requests must be rejected");
  }
  const administration = await fetch(`${baseUrl.replace(/\/$/, "")}/v2/users`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  });
  await administration.body?.cancel();
  if (administration.status !== 401 && administration.status !== 403) {
    throw new Error("hosted wallet submission token must not have user-administration access");
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("hosted wallet ledger token cannot read its dedicated user's rights");
  }
  const body = await response.json() as { rights?: Array<{ kind?: Record<string, unknown> }> };
  if (!Array.isArray(body.rights) || body.rights.some(right => {
    const kinds = Object.keys(right.kind ?? {});
    return kinds.length !== 1 || !["CanReadAs", "CanExecuteAs"].includes(kinds[0]!);
  })) throw new Error("hosted wallet ledger user must have only CanReadAs and CanExecuteAs rights");
}
