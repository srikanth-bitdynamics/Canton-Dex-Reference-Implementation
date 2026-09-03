// Session service (the BFF core): off-ledger signMessage verification.
//
// On connect the wallet signs a challenge with its CIP-0103 `signMessage`
// capability and the backend verifies it WITHOUT any participant/topology
// access, using only what the wallet returns:
//   1. Ed25519-verify the signature over the challenge message against the
//      account's public key.
//   2. Confirm the public key binds to the party: a SHA-256 fingerprint of the
//      key must equal the segment after `::` in the party id (with the `1220`
//      multihash prefix stripped).
// When both pass, mint the scoped HS256 caller token; otherwise the message is
// captured and logged but NO token is minted.
//
// Flow:
//   1. challenge(party) -> a structured, single-use message binding the domain,
//      network, party, nonce, and validity window, plus the raw nonce/expiry.
//   2. the wallet signs that message (signMessage) and returns a SignedMessage.
//   3. verify(party, nonce, signedMessage, account?) -> structural checks, then
//      (when the wallet supplied its public key) Ed25519 + fingerprint-binding
//      checks and, on success, a minted caller token.

import { createHash, createHmac, createPublicKey, randomBytes, verify as edVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import type { Party } from "../types.js";
import { rootLogger } from "../lib/logger.js";

const sessionLog = rootLogger.child({ component: "session" });

// A challenge nonce is accepted this long before the wallet must restart.
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
// TTL for the caller token minted once the wallet signature is verified.
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

// SPKI DER prefix wrapping a raw 32-byte Ed25519 public key (RFC 8410).
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
// The multihash prefix on a Canton namespace fingerprint: sha2-256, 32 bytes.
const MULTIHASH_SHA256_PREFIX = "1220";
// Canton derives a fingerprint by hashing the key under a 4-byte hash-purpose
// prefix; the exact purpose is not observable off-ledger, so the binding check
// tries this set (12 first) until a live sample pins it down.
const HASH_PURPOSES = [12, 11, 13, 0, 1, 2, 3, 4, 5, 6, 7, 8];

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Compact HS256 JWT mint -- the mirror of caller-auth.verifyHs256. Mints the
// scoped caller token once the wallet signature and its party binding verify.
function signHs256(claims: Record<string, unknown>, secret: string): string {
  const header = base64Url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(Buffer.from(JSON.stringify(claims)));
  const sig = base64Url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

export interface SessionConfig {
  /** HS256 secret the caller tokens are signed with in the verification phase. */
  callerJwtSecret: string;
  /** Optional `aud` stamped on the token in the verification phase. */
  callerJwtAudience?: string | undefined;
  /** Origin / audience the challenge binds (the app's configured API origin). */
  domain: string;
  /** Network id the challenge binds. */
  networkId: string;
}

export interface Challenge {
  message: string;
  nonce: string;
  expiresAt: number; // unix ms
  domain: string;
}

// The message the wallet signs, echoed back verbatim in SignedMessage.message.
export interface SignedMessage {
  signature: string;
  partyId: string;
  message: string;
  nonce?: string;
  domain?: string;
}

// The account material the wallet supplies alongside the signature so the
// backend can verify off-ledger. `publicKey` encoding is determined at runtime.
export interface SessionAccount {
  publicKey?: string;
  namespace?: string;
}

export interface VerifyResult {
  /** The signed message was captured and logged. */
  captured: boolean;
  /** Signature verified AND its public key binds to the party. */
  verified: boolean;
  /** Scoped HS256 caller token, present only when `verified`. */
  callerToken?: string;
  /** The verified party, present only when `verified`. */
  party?: Party;
  /** Caller-token expiry (unix ms), present only when `verified`. */
  expiresAt?: number;
}

export class SessionError extends Error {}

// The Canton party namespace fingerprint: the segment after `::` in a party id.
function namespaceFingerprint(partyId: string): string | null {
  const i = partyId.indexOf("::");
  return i >= 0 ? partyId.slice(i + 2) : null;
}

// The raw SHA-256 digest a fingerprint binds to: the namespace fingerprint with
// its `1220` multihash prefix stripped, lowercased.
function fingerprintDigest(partyId: string): string | null {
  const fp = namespaceFingerprint(partyId);
  if (!fp) return null;
  const lower = fp.toLowerCase();
  return lower.startsWith(MULTIHASH_SHA256_PREFIX) ? lower.slice(4) : lower;
}

// Decode a wallet-supplied string as bytes, trying hex, then base64/base64url.
// A hex-first order is required: raw and DER Ed25519 keys are valid hex and
// would otherwise be misread as base64.
function decodeBytes(s: string): Buffer | null {
  if (s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) {
    return Buffer.from(s, "hex");
  }
  const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return b.length > 0 ? b : null;
}

function tryPublicKey(der: Buffer): KeyObject | null {
  try {
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

// From decoded key bytes, derive the Ed25519 KeyObject to verify against plus
// the raw 32-byte and DER/SPKI forms used as fingerprint preimages.
function keyMaterial(decoded: Buffer): {
  keyObject: KeyObject | null;
  raw32: Buffer | null;
  der: Buffer | null;
} {
  if (decoded.length === 32) {
    const der = Buffer.concat([SPKI_ED25519_PREFIX, decoded]);
    return { keyObject: tryPublicKey(der), raw32: decoded, der };
  }
  if (
    decoded.length >= SPKI_ED25519_PREFIX.length + 32 &&
    decoded.subarray(0, SPKI_ED25519_PREFIX.length).equals(SPKI_ED25519_PREFIX)
  ) {
    const raw32 = decoded.subarray(
      SPKI_ED25519_PREFIX.length,
      SPKI_ED25519_PREFIX.length + 32,
    );
    return { keyObject: tryPublicKey(decoded), raw32, der: decoded };
  }
  return { keyObject: tryPublicKey(decoded), raw32: null, der: decoded };
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function purposePrefixed(purpose: number, body: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(purpose >>> 0, 0);
  return Buffer.concat([prefix, body]);
}

// The fingerprint preimages Canton might hash. The exact convention (preimage
// serialization + hash purpose) is not observable off-ledger; the live sample
// logged by [session:verify-attempt] pins down which candidate is real.
function fingerprintCandidates(
  raw32: Buffer | null,
  der: Buffer | null,
  decoded: Buffer,
): { label: string; hex: string }[] {
  const out: { label: string; hex: string }[] = [];
  if (raw32) {
    out.push({ label: "raw", hex: sha256Hex(raw32) });
    out.push({
      label: "multicodec-ed25519-pub",
      hex: sha256Hex(Buffer.concat([Buffer.from([0xed, 0x01]), raw32])),
    });
    for (const p of HASH_PURPOSES) {
      out.push({ label: `purpose${p}+raw`, hex: sha256Hex(purposePrefixed(p, raw32)) });
    }
  }
  if (der) {
    out.push({ label: "der", hex: sha256Hex(der) });
    for (const p of HASH_PURPOSES) {
      out.push({ label: `purpose${p}+der`, hex: sha256Hex(purposePrefixed(p, der)) });
    }
  }
  if (!raw32 && !der) out.push({ label: "decoded", hex: sha256Hex(decoded) });
  return out;
}

function buildChallengeMessage(fields: {
  domain: string;
  networkId: string;
  party: Party;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}): string {
  return [
    "Canton DEX session",
    `domain: ${fields.domain}`,
    `network: ${fields.networkId}`,
    `party: ${fields.party}`,
    `nonce: ${fields.nonce}`,
    `issuedAt: ${new Date(fields.issuedAt).toISOString()}`,
    `expiresAt: ${new Date(fields.expiresAt).toISOString()}`,
    "purpose: dex-session",
  ].join("\n");
}

export class SessionService {
  // Outstanding challenges: nonce -> { party, message, expiresAt }. In-memory: a
  // nonce is a one-time freshness proof; losing them on restart just forces a
  // re-challenge.
  private readonly pending = new Map<
    string,
    { party: Party; message: string; expiresAt: number }
  >();

  constructor(
    private readonly cfg: SessionConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private sweep(): void {
    const t = this.now();
    for (const [nonce, e] of this.pending) if (e.expiresAt <= t) this.pending.delete(nonce);
  }

  challenge(party: Party): Challenge {
    this.sweep();
    const nonce = randomBytes(32).toString("hex"); // 256-bit
    const issuedAt = this.now();
    const expiresAt = issuedAt + CHALLENGE_TTL_MS;
    const message = buildChallengeMessage({
      domain: this.cfg.domain,
      networkId: this.cfg.networkId,
      party,
      nonce,
      issuedAt,
      expiresAt,
    });
    this.pending.set(nonce, { party, message, expiresAt });
    return { message, nonce, expiresAt, domain: this.cfg.domain };
  }

  verify(
    party: Party,
    nonce: string,
    signedMessage: SignedMessage,
    account?: SessionAccount,
  ): VerifyResult {
    this.sweep();
    const pending = this.pending.get(nonce);
    if (!pending || pending.party !== party) {
      throw new SessionError("unknown or expired challenge for this party");
    }
    if (pending.expiresAt <= this.now()) {
      this.pending.delete(nonce);
      throw new SessionError("challenge expired");
    }
    if (signedMessage.partyId !== party) {
      throw new SessionError("signed message party does not match the challenge party");
    }
    if (signedMessage.message !== pending.message) {
      throw new SessionError("signed message does not match the issued challenge");
    }
    if (signedMessage.nonce !== undefined && signedMessage.nonce !== nonce) {
      throw new SessionError("signed message nonce does not match the challenge nonce");
    }

    // Capture: log the full SignedMessage as JSON so the real signature can be
    // studied in the server journal. The challenge and signature are not secret.
    sessionLog.info("[session:capture] captured wallet signMessage", {
      signedMessage: {
        signature: signedMessage.signature,
        partyId: signedMessage.partyId,
        message: signedMessage.message,
        nonce: signedMessage.nonce,
        domain: signedMessage.domain,
      },
      namespace: namespaceFingerprint(signedMessage.partyId),
    });

    // Structural checks passed and the nonce is spent regardless of the crypto
    // outcome (single-use).
    this.pending.delete(nonce);

    // No public key supplied -> capture-only, mint nothing.
    if (!account?.publicKey) {
      return { captured: true, verified: false };
    }

    const decoded = decodeBytes(account.publicKey);
    const { keyObject, raw32, der } = decoded
      ? keyMaterial(decoded)
      : { keyObject: null, raw32: null, der: null };

    // Ed25519 over the utf8 message, and over its SHA-256 digest in case the
    // wallet pre-hashes.
    const sig = decodeBytes(signedMessage.signature);
    const msgBytes = Buffer.from(signedMessage.message, "utf8");
    const sigVariants = { utf8: false, sha256: false };
    if (keyObject && sig) {
      try {
        sigVariants.utf8 = edVerify(null, msgBytes, keyObject, sig);
      } catch {
        /* wrong key/sig shape -> not verified */
      }
      try {
        sigVariants.sha256 = edVerify(
          null,
          createHash("sha256").update(msgBytes).digest(),
          keyObject,
          sig,
        );
      } catch {
        /* not verified */
      }
    }
    const signatureVerified = sigVariants.utf8 || sigVariants.sha256;

    const target = fingerprintDigest(party);
    const candidates = decoded ? fingerprintCandidates(raw32, der, decoded) : [];
    const matched = target ? candidates.find((c) => c.hex === target) : undefined;
    const bindingVerified = matched !== undefined;

    const verified = signatureVerified && bindingVerified;

    sessionLog.info("[session:verify-attempt]", {
      publicKey: account.publicKey,
      publicKeyNamespace: account.namespace,
      decodedByteLength: decoded ? decoded.length : null,
      partySuffix: target,
      signatureVariants: sigVariants,
      keyRawSha256: raw32 ? sha256Hex(raw32) : null,
      keyDerSha256: der ? sha256Hex(der) : null,
      fingerprintCandidates: candidates.map((c) => ({
        label: c.label,
        hex: c.hex,
        matched: c.hex === target,
      })),
      matchedCandidate: matched?.label ?? null,
      decision: { signatureVerified, bindingVerified, verified },
    });

    if (!verified) {
      return { captured: true, verified: false };
    }

    const iat = Math.floor(this.now() / 1000);
    const exp = iat + TOKEN_TTL_SECONDS;
    const claims: Record<string, unknown> = { sub: party, iat, exp };
    if (this.cfg.callerJwtAudience) claims.aud = this.cfg.callerJwtAudience;
    const callerToken = signHs256(claims, this.cfg.callerJwtSecret);

    return { captured: true, verified: true, callerToken, party, expiresAt: exp * 1000 };
  }
}
