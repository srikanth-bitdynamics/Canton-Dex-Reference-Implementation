import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as edSign,
  type KeyObject,
} from "node:crypto";

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

// Read a compact JWT's claims without verifying (the tests trust the local mint).
function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(
    Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );
}

// A structurally valid HS256 token signed with the same secret but with no
// bootstrap typ — verifyBootstrap must still reject it.
function signedCallerLikeToken(): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ sub: PARTY, exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
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

test("the signature-path token carries auth_method:signature and the network", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const party = partyForKey("alice", publicKey);
  const s = svc();
  const c = s.challenge(party);
  const signature = edSign(null, Buffer.from(c.message, "utf8"), privateKey).toString("hex");
  const sm: SignedMessage = { signature, partyId: party, message: c.message, nonce: c.nonce };
  const r = s.verify(party, c.nonce, sm, { publicKey: rawPublicKey(publicKey).toString("hex") });
  const claims = decodeJwt(r.callerToken as string);
  assert.equal(claims.auth_method, "signature");
  assert.equal(claims.network, NETWORK);
});

// === bootstrap-bound minting ============================================

test("createBootstrap round-trips through verifyBootstrap", () => {
  const s = svc();
  const { bootstrapToken, expiresAt } = s.createBootstrap();
  assert.ok(typeof bootstrapToken === "string" && bootstrapToken.length > 0);
  assert.ok(expiresAt > Date.now());
  const { jti, nonceHash } = s.verifyBootstrap(bootstrapToken);
  assert.ok(jti.length > 0);
  assert.equal(nonceHash.length, 64); // sha256 hex
  const claims = decodeJwt(bootstrapToken);
  assert.equal(claims.typ, "dex-bootstrap");
  assert.equal(claims.network, NETWORK);
  assert.equal(claims.nonceHash, nonceHash);
  assert.equal(claims.jti, jti);
});

test("a bootstrap token is rejected by caller-token verification (distinct typ)", () => {
  const s = svc();
  const { bootstrapToken } = s.createBootstrap();
  // Even ignoring exp, the dex-bootstrap typ must be refused as a caller token.
  assert.equal(verifyHs256(bootstrapToken, SECRET, { requireExp: false }), null);
});

test("verifyBootstrap rejects a tampered / non-bootstrap / expired token", () => {
  const s = svc();
  const { bootstrapToken } = s.createBootstrap();
  const [h, p, sig] = bootstrapToken.split(".");
  // Tampered signature.
  assert.throws(() => s.verifyBootstrap(`${h}.${p}.${sig}AA`), SessionError);
  // A structurally valid HS256 token that is not a bootstrap (no typ).
  const notBootstrap = signedCallerLikeToken();
  assert.throws(() => s.verifyBootstrap(notBootstrap), SessionError);
});

test("mintFromLedgerProof mints when authBinding == nonceHash and a party is proven", () => {
  const s = svc();
  const { bootstrapToken } = s.createBootstrap();
  const { nonceHash } = s.verifyBootstrap(bootstrapToken);
  const minted = s.mintFromLedgerProof(bootstrapToken, PARTY, nonceHash);
  assert.ok(minted);
  assert.ok((minted!.expiresAt ?? 0) > Date.now());
  const claims = verifyHs256(minted!.callerToken, SECRET, { audience: AUDIENCE });
  assert.equal(claims?.sub, PARTY);
  assert.equal(claims?.auth_method, "ledger-allocation");
  assert.equal(claims?.network, NETWORK);
});

test("mintFromLedgerProof returns null when the binding differs from the nonceHash", () => {
  const s = svc();
  const { bootstrapToken } = s.createBootstrap();
  assert.equal(s.mintFromLedgerProof(bootstrapToken, PARTY, "deadbeef".repeat(8)), null);
});

test("mintFromLedgerProof returns null when no party was proven (authenticatedParty None)", () => {
  const s = svc();
  const { bootstrapToken } = s.createBootstrap();
  const { nonceHash } = s.verifyBootstrap(bootstrapToken);
  assert.equal(s.mintFromLedgerProof(bootstrapToken, "", nonceHash), null);
});

test("mintFromLedgerProof is idempotent for the same party, null for a different one", () => {
  const s = svc();
  const { bootstrapToken } = s.createBootstrap();
  const { nonceHash } = s.verifyBootstrap(bootstrapToken);
  const first = s.mintFromLedgerProof(bootstrapToken, PARTY, nonceHash);
  assert.ok(first);
  // A retry by the same proven party returns the cached token.
  const retry = s.mintFromLedgerProof(bootstrapToken, PARTY, nonceHash);
  assert.equal(retry?.callerToken, first!.callerToken);
  // A different party presenting the same (consumed) bootstrap gets nothing.
  assert.equal(s.mintFromLedgerProof(bootstrapToken, "mallory::1220ff", nonceHash), null);
});

test("mintFromLedgerProof returns null after the bootstrap TTL lapses", () => {
  let t = 1_000_000;
  const s = svc(() => t);
  const { bootstrapToken } = s.createBootstrap();
  const { nonceHash } = s.verifyBootstrap(bootstrapToken);
  t += 6 * 60 * 1000; // past the 5-minute bootstrap TTL
  assert.equal(s.mintFromLedgerProof(bootstrapToken, PARTY, nonceHash), null);
});
