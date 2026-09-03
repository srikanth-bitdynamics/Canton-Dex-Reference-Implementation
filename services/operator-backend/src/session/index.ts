// Session service (the BFF core): turns a wallet's on-ledger proof-of-control
// into a short-lived, party-scoped caller JWT, so a public user drives their own
// trader-flow writes without ever holding the venue operator token.
//
// Flow:
//   1. challenge(party) -> a random single-use nonce + the verifier party the
//      wallet must name as observer.
//   2. the wallet self-authors SessionAttestation{party, verifier, nonce, expiresAt}
//      (CIP-0103) -- only that party's key can create it.
//   3. verify(party, nonce) -> read the ACS as the verifier for a matching,
//      unexpired attestation, mint a caller JWT (sub=party, exp, aud), consume the
//      attestation, and return the token.
//
// Forging a token for a party you do not control cannot move that party's funds
// (settlement still needs its wallet to author the allocations); this binding
// protects the party-scoped reads and stops a caller acting as anyone else.

import { createHmac, randomBytes } from "node:crypto";

import type { LedgerSubmitter } from "../ledger/index.js";
import type { Party } from "../types.js";

const ATTESTATION_TEMPLATE = "CantonDex.Session.Attestation:SessionAttestation";

// A challenge nonce is accepted this long before the wallet must restart.
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
// Minted caller tokens last a work session so the user signs the proof once per
// connect. A leaked token cannot move funds (settlement still needs the party's
// own wallet to author allocations); it only scopes reads and orchestration to
// that party, so a session-length TTL is an acceptable trade for the UX.
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Sign a compact HS256 JWT -- the mirror of caller-auth.verifyHs256.
function signHs256(claims: Record<string, unknown>, secret: string): string {
  const header = base64Url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(Buffer.from(JSON.stringify(claims)));
  const sig = base64Url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

interface SessionAttestationContract {
  contractId: string;
  party: string;
  verifier: string;
  nonce: string;
  expiresAt: string; // ISO Time
}

export interface SessionConfig {
  /** HS256 secret the minted caller tokens are signed with (== DEX_CALLER_JWT_SECRET). */
  callerJwtSecret: string;
  /** Optional `aud` stamped on the token (== DEX_CALLER_JWT_AUDIENCE). */
  callerJwtAudience?: string | undefined;
  /** The operator/verifier party that observes attestations. */
  verifier: Party;
}

export interface Challenge {
  nonce: string;
  verifier: Party;
  expiresAt: number; // unix ms
}

export interface SessionToken {
  callerToken: string;
  party: Party;
  expiresAt: number; // unix seconds
}

export class SessionError extends Error {}

export class SessionService {
  // Outstanding challenges: nonce -> { party, expiresAt }. In-memory: a nonce is
  // a one-time freshness proof; losing them on restart just forces a re-challenge.
  private readonly pending = new Map<string, { party: Party; expiresAt: number }>();

  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly cfg: SessionConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private sweep(): void {
    const t = this.now();
    for (const [nonce, e] of this.pending) if (e.expiresAt <= t) this.pending.delete(nonce);
  }

  challenge(party: Party): Challenge {
    this.sweep();
    const nonce = base64Url(randomBytes(24));
    const expiresAt = this.now() + CHALLENGE_TTL_MS;
    this.pending.set(nonce, { party, expiresAt });
    return { nonce, verifier: this.cfg.verifier, expiresAt };
  }

  async verify(party: Party, nonce: string): Promise<SessionToken> {
    this.sweep();
    const pending = this.pending.get(nonce);
    if (!pending || pending.party !== party) {
      throw new SessionError("unknown or expired challenge for this party");
    }

    const attestations = await this.ledger.query<SessionAttestationContract>({
      templateId: ATTESTATION_TEMPLATE,
      observingParty: this.cfg.verifier,
    });
    const t = this.now();
    const match = attestations.find(
      (a) =>
        a.party === party &&
        a.nonce === nonce &&
        a.verifier === this.cfg.verifier &&
        Date.parse(a.expiresAt) > t,
    );
    if (!match) {
      throw new SessionError("no matching on-ledger proof-of-control found");
    }

    // Burn the nonce first: even if the consume submit fails, the proof cannot be
    // replayed for another token.
    this.pending.delete(nonce);

    // Consume the attestation (single-use). Best-effort: the token is valid
    // regardless, and the nonce is already burned.
    try {
      await this.ledger.submit({
        actAs: [this.cfg.verifier],
        commandId: `session-consume-${match.contractId.slice(0, 16)}-${t}`,
        command: {
          kind: "exercise",
          templateId: ATTESTATION_TEMPLATE,
          contractId: match.contractId,
          choice: "SessionAttestation_Consume",
          argument: {},
        },
      });
    } catch {
      // ignore
    }

    const iat = Math.floor(t / 1000);
    const exp = iat + TOKEN_TTL_SECONDS;
    const claims: Record<string, unknown> = { sub: party, iat, exp };
    if (this.cfg.callerJwtAudience) claims.aud = this.cfg.callerJwtAudience;
    const callerToken = signHs256(claims, this.cfg.callerJwtSecret);
    return { callerToken, party, expiresAt: exp };
  }
}
