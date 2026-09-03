// Client half of the session-service (BFF) flow.
//
// On connect the dApp asks the connected wallet to sign a backend-issued
// challenge (off-ledger CIP-0103 signMessage) and posts the SignedMessage back,
// together with the wallet's primary-account public key, so the backend can
// verify the signature and its party binding off-ledger and mint a scoped caller
// token. This is deliberately best-effort — a failure here must never break the
// wallet connection.

import { getProvider } from "../wallet/registry";
import { useWalletStore } from "../wallet/store";
import { clearCallerToken, setCallerToken } from "./api-auth";

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
 * Ask the connected wallet to sign the backend challenge so the backend can
 * verify it and mint a caller token. Returns true when the backend captured the
 * SignedMessage (whether or not a token was minted), false when the deployment
 * runs no session service (a 501), the active wallet cannot sign, or anything
 * went wrong. Never throws — the connection must not break because of the
 * session.
 */
export async function establishSession(party: string): Promise<boolean> {
  clearCallerToken(); // drop any token for a previous party
  try {
    const ch = await postJson<Challenge>("/v1/session/challenge", { party });
    if (ch.status === 501) return false; // no session service on this deployment
    if (!ch.ok || !ch.data) {
      console.warn("[session] challenge failed:", ch.status, ch.text.slice(0, 200));
      return false;
    }

    const providerId = useWalletStore.getState().activeProviderId;
    const provider = providerId ? getProvider(providerId) : null;
    if (!provider?.signMessage) {
      console.warn(
        "[session] active wallet does not support signMessage; skipping session (capture phase)",
      );
      return false;
    }

    const signedMessage = await provider.signMessage({
      message: ch.data.message,
      nonce: ch.data.nonce,
      domain: ch.data.domain,
    });

    // Best-effort: the wallet's public key lets the backend verify off-ledger.
    // Omit it when unavailable — the backend then only captures.
    let account: { publicKey: string; namespace?: string } | undefined;
    let accountDebug: unknown;
    try {
      const primary = await provider.getPrimaryAccount?.();
      accountDebug = { hasMethod: !!provider.getPrimaryAccount, primary };
      if (primary?.publicKey) {
        account = {
          publicKey: primary.publicKey,
          ...(primary.namespace ? { namespace: primary.namespace } : {}),
        };
      }
    } catch (e) {
      accountDebug = { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
      console.warn("[session] getPrimaryAccount failed (non-fatal):", e);
    }

    const res = await postJson<{ captured?: boolean; verified?: boolean; callerToken?: string }>(
      "/v1/session/verify",
      {
        party,
        nonce: ch.data.nonce,
        signedMessage,
        ...(account ? { account } : {}),
        accountDebug,
      },
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

/** Drop the caller session (on disconnect). */
export function endSession(): void {
  clearCallerToken();
}
