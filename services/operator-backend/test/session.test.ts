import { test } from "node:test";
import assert from "node:assert/strict";

import { SessionService, SessionError } from "../src/session/index.js";
import { verifyHs256 } from "../src/http/caller-auth.js";
import type { LedgerSubmitter, SubscriptionFilter } from "../src/ledger/index.js";

const SECRET = "test-caller-secret";
const VERIFIER = "operator::1220ab";
const PARTY = "alice::1220cd";

// A stub ledger: `query` returns whatever attestations we stage; `submit`
// records the consume exercise. Only the two methods the session service uses
// are implemented.
function stubLedger(attestations: unknown[]): LedgerSubmitter & { submitted: unknown[] } {
  const submitted: unknown[] = [];
  return {
    submitted,
    async query<T>(_filter: SubscriptionFilter): Promise<T[]> {
      return attestations as T[];
    },
    async submit<R>(req: unknown): Promise<R> {
      submitted.push(req);
      return {} as R;
    },
  } as LedgerSubmitter & { submitted: unknown[] };
}

function svc(ledger: LedgerSubmitter, now?: () => number): SessionService {
  return new SessionService(
    ledger,
    { callerJwtSecret: SECRET, callerJwtAudience: "canton-dex", verifier: VERIFIER },
    now,
  );
}

function attestation(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    contractId: "00att",
    party: PARTY,
    verifier: VERIFIER,
    nonce: "PLACEHOLDER",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
}

test("challenge issues a party-bound single-use nonce and the verifier", () => {
  const s = svc(stubLedger([]));
  const c = s.challenge(PARTY);
  assert.equal(c.verifier, VERIFIER);
  assert.ok(c.nonce.length > 10);
  assert.ok(c.expiresAt > Date.now());
});

test("verify mints a party-scoped caller token from a matching on-ledger proof", async () => {
  const ledger = stubLedger([]);
  const s = svc(ledger);
  const c = s.challenge(PARTY);
  // Stage the attestation the wallet would have self-authored for this nonce.
  (ledger as { query: unknown }).query = async () => [attestation({ nonce: c.nonce })];

  const tok = await s.verify(PARTY, c.nonce);
  assert.equal(tok.party, PARTY);
  const claims = verifyHs256(tok.callerToken, SECRET, { audience: "canton-dex" });
  assert.ok(claims, "token verifies under the caller secret + audience");
  assert.equal(claims!.sub, PARTY);
  assert.equal(typeof claims!.exp, "number");
  // The attestation is consumed (single-use).
  assert.equal(ledger.submitted.length, 1);
});

test("verify rejects when no matching proof is on-ledger", async () => {
  const ledger = stubLedger([]); // ACS empty
  const s = svc(ledger);
  const c = s.challenge(PARTY);
  await assert.rejects(() => s.verify(PARTY, c.nonce), SessionError);
});

test("verify rejects a proof whose party or verifier does not match", async () => {
  const ledger = stubLedger([]);
  const s = svc(ledger);
  const c = s.challenge(PARTY);
  (ledger as { query: unknown }).query = async () => [
    attestation({ nonce: c.nonce, party: "mallory::1220ff" }),
  ];
  await assert.rejects(() => s.verify(PARTY, c.nonce), SessionError);
});

test("verify rejects an expired on-ledger proof", async () => {
  const ledger = stubLedger([]);
  const s = svc(ledger);
  const c = s.challenge(PARTY);
  (ledger as { query: unknown }).query = async () => [
    attestation({ nonce: c.nonce, expiresAt: new Date(Date.now() - 1000).toISOString() }),
  ];
  await assert.rejects(() => s.verify(PARTY, c.nonce), SessionError);
});

test("an unknown nonce is rejected (challenge required first)", async () => {
  const ledger = stubLedger([attestation({ nonce: "never-issued" })]);
  const s = svc(ledger);
  await assert.rejects(() => s.verify(PARTY, "never-issued"), SessionError);
});

test("a nonce is single-use: the second verify is rejected", async () => {
  const ledger = stubLedger([]);
  const s = svc(ledger);
  const c = s.challenge(PARTY);
  (ledger as { query: unknown }).query = async () => [attestation({ nonce: c.nonce })];
  await s.verify(PARTY, c.nonce);
  await assert.rejects(() => s.verify(PARTY, c.nonce), SessionError);
});

test("a challenge is rejected after its TTL lapses", async () => {
  let t = 1_000_000;
  const ledger = stubLedger([]);
  const s = svc(ledger, () => t);
  const c = s.challenge(PARTY);
  (ledger as { query: unknown }).query = async () => [attestation({ nonce: c.nonce })];
  t += 3 * 60 * 1000; // past the 2-minute challenge TTL
  await assert.rejects(() => s.verify(PARTY, c.nonce), SessionError);
});
