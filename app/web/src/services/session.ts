// Client half of the session-service (BFF) flow. Wallet connect is a sign-in
// (partyId + networkId), not party authentication.
//
// On connect the client always fetches a one-time bootstrap token and holds it;
// it is presented on trade request/settle so the backend can bind it into the
// on-ledger allocation and, after a valid settle, return a party JWT (stored as
// the caller token). A wallet that exposes a verifiable public key can instead
// take a signMessage fast path straight to a caller token at connect. This is
// deliberately best-effort — a failure here must never break the connection.

import { getProvider, type WalletProviderId } from "../wallet/registry";
import { useWalletStore } from "../wallet/store";
import { capabilityFor } from "../wallet/capabilities";
import {
  clearBootstrapToken,
  clearCallerToken,
  setBootstrapToken,
  setCallerToken,
} from "./api-auth";

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8080";

interface Challenge {
  message: string;
  nonce: string;
  expiresAt: number;
  domain?: string;
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
 * Sign in the connected party. Always fetches a one-time bootstrap token and
 * holds it. A wallet that both advertises signMessage and exposes a verifiable
 * public key takes the fast path to a caller token; a keyless wallet (e.g. Loop)
 * does nothing more on the network — its party JWT arrives after the first
 * settle. Returns true only when the fast path verified. Never throws, and a
 * missing session service (501) or any failure just skips — the connection
 * still works.
 */
export async function establishSession(party: string): Promise<boolean> {
  clearCallerToken(); // drop any token for a previous party
  clearBootstrapToken();

  // Always: fetch and hold the bootstrap token. Skip on 501 or any failure.
  try {
    const boot = await postJson<{ bootstrapToken: string; expiresAt: number }>(
      "/v1/session/bootstrap",
      { party },
    );
    if (boot.ok && boot.data && boot.data.bootstrapToken) {
      setBootstrapToken(boot.data.bootstrapToken);
    }
  } catch (e) {
    console.warn("[session] bootstrap failed (non-fatal):", e);
  }

  const providerId = useWalletStore.getState().activeProviderId as
    | WalletProviderId
    | null;
  // Fast path only for a signMessage-capable provider. Only then do we probe
  // for a public key (no debug plumbing).
  if (!providerId || !capabilityFor(providerId).supportsSignMessage) return false;

  const provider = getProvider(providerId);
  let account: { publicKey: string; namespace?: string } | undefined;
  try {
    const primary = await provider.getPrimaryAccount?.();
    if (primary?.publicKey) {
      account = {
        publicKey: primary.publicKey,
        ...(primary.namespace ? { namespace: primary.namespace } : {}),
      };
    }
  } catch (e) {
    console.warn("[session] getPrimaryAccount failed (non-fatal):", e);
  }
  // Keyless wallet (e.g. Loop): no verifiable public key, so no challenge and no
  // signMessage prompt. The party JWT arrives after the first settle.
  if (!account || !provider.signMessage) return false;

  try {
    const ch = await postJson<Challenge>("/v1/session/challenge", { party });
    if (!ch.ok || !ch.data) {
      if (ch.status !== 501) {
        console.warn("[session] challenge failed:", ch.status, ch.text.slice(0, 200));
      }
      return false;
    }

    const signedMessage = await provider.signMessage({
      message: ch.data.message,
      nonce: ch.data.nonce,
      domain: ch.data.domain,
    });

    const res = await postJson<{ captured?: boolean; verified?: boolean; callerToken?: string }>(
      "/v1/session/verify",
      { party, nonce: ch.data.nonce, signedMessage, account },
    );
    if (!res.ok || !res.data) {
      console.warn("[session] verify failed:", res.status, res.text.slice(0, 200));
      return false;
    }
    if (typeof res.data.callerToken === "string" && res.data.callerToken) {
      setCallerToken(res.data.callerToken); // enable trading for this party
    }
    return res.data.captured === true;
  } catch (e) {
    console.warn("[session] establishSession failed (non-fatal):", e);
    return false;
  }
}

/** Drop the caller session and bootstrap token (on disconnect). */
export function endSession(): void {
  clearCallerToken();
  clearBootstrapToken();
}
