// Client half of the session-service (BFF) flow.
//
// On connect the dApp turns the connected party's on-ledger proof-of-control
// into a scoped caller token, stored so `api-auth` attaches it as X-Caller-Token
// on trader-flow writes. The venue operator secret never touches the browser.
//
// Flow: challenge -> the wallet self-authors a SessionAttestation (only that
// party can) -> verify -> caller token. A deployment that runs no session
// service (an operator-token deployment) returns a no-op.

import { handToWallet } from "../wallet/handoff";
import type { AttestSessionIntent } from "../wallet/types";
import { setCallerToken, clearCallerToken } from "./api-auth";

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8080";

interface Challenge {
  nonce: string;
  verifier: string;
  expiresAt: number;
}
interface SessionTokenResponse {
  callerToken: string;
  party: string;
  expiresAt: number;
}

async function postJson<T>(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    // leave null; caller surfaces the raw text
  }
  return { ok: res.ok, status: res.status, data, text };
}

/**
 * Establish a scoped caller session for `party`. Returns true when a token was
 * minted, false when the deployment runs no session service (a 501 — the
 * operator-token path still applies). Throws only on an unexpected failure the
 * caller may surface.
 */
export async function establishSession(party: string): Promise<boolean> {
  clearCallerToken(); // drop any token for a previous party
  const ch = await postJson<Challenge>("/v1/session/challenge", { party });
  if (ch.status === 501) return false; // no session service on this deployment
  if (!ch.ok || !ch.data) {
    throw new Error(`session challenge failed: ${ch.status} ${ch.text.slice(0, 200)}`);
  }

  // The wallet self-authors the on-ledger proof (only this party can create it).
  const intent: AttestSessionIntent = {
    kind: "attest-session",
    verifier: ch.data.verifier,
    nonce: ch.data.nonce,
    expiresAt: new Date(ch.data.expiresAt).toISOString(),
  };
  await handToWallet(intent);

  const tok = await postJson<SessionTokenResponse>("/v1/session/verify", {
    party,
    nonce: ch.data.nonce,
  });
  if (!tok.ok || !tok.data) {
    throw new Error(`session verify failed: ${tok.status} ${tok.text.slice(0, 200)}`);
  }
  setCallerToken(tok.data.callerToken);
  return true;
}

/** Drop the caller session (on disconnect). */
export function endSession(): void {
  clearCallerToken();
}
