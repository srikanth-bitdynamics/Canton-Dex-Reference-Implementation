import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";

import { SessionService, SessionError, type SignedMessage } from "../src/session/index.js";
import { verifyHs256 } from "../src/http/caller-auth.js";

const SECRET = "test-caller-secret";
const AUDIENCE = "canton-dex";
const DOMAIN = "https://dex.example";
const NETWORK = "canton:devnet";
const PARTY = "alice::1220cd";

// The raw 32-byte Ed25519 public key behind a generated KeyObject.
function rawPublicKey(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32);
}

// A party id whose namespace fingerprint is the `raw` candidate the service
// derives: 1220 (sha2-256 multihash) + sha256(rawPublicKey).
function partyForKey(hint: string, publicKey: KeyObject): string {
  const digest = createHash("sha256").update(rawPublicKey(publicKey)).digest("hex");
  return `${hint}::1220${digest}`;
}

function svc(now?: () => number): SessionService {
  return new SessionService(
    { callerJwtSecret: SECRET, callerJwtAudience: AUDIENCE, domain: DOMAIN, networkId: NETWORK },
    now,
  );
}

// The SignedMessage the wallet returns for a challenge, echoing the issued
// message and nonce.
function signedFor(
  message: string,
  nonce: string,
  over: Partial<SignedMessage> = {},
): SignedMessage {
  return { signature: "sig-opaque", partyId: PARTY, message, nonce, domain: DOMAIN, ...over };
}

test("challenge issues a party-bound message, nonce, expiry, and domain", () => {
  const s = svc();
  const c = s.challenge(PARTY);
  assert.equal(typeof c.message, "string");
  assert.ok(c.message.includes(PARTY), "message binds the party");
  assert.ok(c.message.includes(NETWORK), "message binds the network");
  assert.ok(c.message.includes("purpose: dex-session"));
  assert.ok(c.nonce.length > 10);
  assert.ok(c.expiresAt > Date.now());
  assert.equal(c.domain, DOMAIN);
});

test("verify captures a well-formed signed message without minting a token", () => {
  const s = svc();
  const c = s.challenge(PARTY);
  const r = s.verify(PARTY, c.nonce, signedFor(c.message, c.nonce));
  assert.equal(r.captured, true);
  assert.equal(r.verified, false);
  // No caller token is minted in the capture phase.
  assert.ok(!("callerToken" in r));
});

test("verify rejects a signed message whose party does not match", () => {
  const s = svc();
  const c = s.challenge(PARTY);
  assert.throws(
    () => s.verify(PARTY, c.nonce, signedFor(c.message, c.nonce, { partyId: "mallory::1220ff" })),
    SessionError,
  );
});

test("verify rejects a signed message that does not match the issued challenge", () => {
  const s = svc();
  const c = s.challenge(PARTY);
  assert.throws(
    () => s.verify(PARTY, c.nonce, signedFor("tampered challenge", c.nonce)),
    SessionError,
  );
});

test("verify rejects a nonce that does not echo the challenge nonce", () => {
  const s = svc();
  const c = s.challenge(PARTY);
  assert.throws(
    () => s.verify(PARTY, c.nonce, signedFor(c.message, "some-other-nonce")),
    SessionError,
  );
});

test("an unknown nonce is rejected (challenge required first)", () => {
  const s = svc();
  assert.throws(
    () => s.verify(PARTY, "never-issued", signedFor("x", "never-issued")),
    SessionError,
  );
});

test("a nonce is single-use: the second verify is rejected", () => {
  const s = svc();
  const c = s.challenge(PARTY);
  s.verify(PARTY, c.nonce, signedFor(c.message, c.nonce));
  assert.throws(() => s.verify(PARTY, c.nonce, signedFor(c.message, c.nonce)), SessionError);
});

test("a challenge is rejected after its TTL lapses", () => {
  let t = 1_000_000;
  const s = svc(() => t);
  const c = s.challenge(PARTY);
  t += 3 * 60 * 1000; // past the 2-minute challenge TTL
  assert.throws(() => s.verify(PARTY, c.nonce, signedFor(c.message, c.nonce)), SessionError);
});

test("verify mints a caller token when the Ed25519 signature and party binding hold", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const party = partyForKey("alice", publicKey);
  const s = svc();
  const c = s.challenge(party);
  const signature = edSign(null, Buffer.from(c.message, "utf8"), privateKey).toString("hex");
  const sm: SignedMessage = {
    signature,
    partyId: party,
    message: c.message,
    nonce: c.nonce,
    domain: DOMAIN,
  };
  const r = s.verify(party, c.nonce, sm, { publicKey: rawPublicKey(publicKey).toString("hex") });
  assert.equal(r.verified, true);
  assert.equal(r.captured, true);
  assert.equal(r.party, party);
  assert.ok(typeof r.callerToken === "string" && r.callerToken.length > 0);
  assert.ok((r.expiresAt ?? 0) > Date.now());
  const claims = verifyHs256(r.callerToken as string, SECRET, { audience: AUDIENCE });
  assert.ok(claims, "minted token verifies against the caller secret");
  assert.equal(claims?.sub, party);
});

test("verify accepts a base64-encoded public key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const party = partyForKey("bob", publicKey);
  const s = svc();
  const c = s.challenge(party);
  const signature = edSign(null, Buffer.from(c.message, "utf8"), privateKey).toString("hex");
  const sm: SignedMessage = { signature, partyId: party, message: c.message, nonce: c.nonce };
  const r = s.verify(party, c.nonce, sm, {
    publicKey: rawPublicKey(publicKey).toString("base64"),
  });
  assert.equal(r.verified, true);
  assert.ok(typeof r.callerToken === "string" && r.callerToken.length > 0);
});

test("verify mints nothing when the supplied public key is the wrong key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const wrong = generateKeyPairSync("ed25519").publicKey;
  const party = partyForKey("alice", publicKey);
  const s = svc();
  const c = s.challenge(party);
  const signature = edSign(null, Buffer.from(c.message, "utf8"), privateKey).toString("hex");
  const sm: SignedMessage = { signature, partyId: party, message: c.message, nonce: c.nonce };
  // Signature was made by `privateKey`, but a different key is presented: both
  // the Ed25519 check and the fingerprint binding fail.
  const r = s.verify(party, c.nonce, sm, { publicKey: rawPublicKey(wrong).toString("hex") });
  assert.equal(r.verified, false);
  assert.equal(r.captured, true);
  assert.ok(!("callerToken" in r) || r.callerToken === undefined);
});

test("verify mints nothing when the key is right but the party binding does not hold", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // A party whose fingerprint does NOT derive from this key.
  const party = "alice::1220" + "ab".repeat(32);
  const s = svc();
  const c = s.challenge(party);
  const signature = edSign(null, Buffer.from(c.message, "utf8"), privateKey).toString("hex");
  const sm: SignedMessage = { signature, partyId: party, message: c.message, nonce: c.nonce };
  const r = s.verify(party, c.nonce, sm, { publicKey: rawPublicKey(publicKey).toString("hex") });
  assert.equal(r.verified, false);
  assert.ok(r.callerToken === undefined);
});
