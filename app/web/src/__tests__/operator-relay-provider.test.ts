import { beforeEach, describe, expect, it, vi } from "vitest";

import { TokenStandardProvider } from "@/wallet/token-standard-provider";

const SESSION_KEY = "canton-dex:token-standard:session";

describe("development operator relay identity", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("is labelled as a relay rather than an external Token Standard wallet", () => {
    const provider = new TokenStandardProvider("http://localhost:8080");
    expect(provider.label).toBe("Operator Relay (dev only)");
  });

  it("sanitizes a restored legacy session down to party and user id", () => {
    window.localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        party: "demo::1220",
        userId: "ledger-api-user",
        token: "legacy-secret",
        ledgerUrl: "https://participant.example",
      }),
    );

    const provider = new TokenStandardProvider("http://localhost:8080");

    expect(provider.getStatus()).toMatchObject({
      kind: "connected",
      account: { party: "demo::1220", label: "Operator Relay (dev only)" },
    });
    expect(JSON.parse(window.localStorage.getItem(SESSION_KEY) ?? "null")).toEqual({
      party: "demo::1220",
      userId: "ledger-api-user",
    });
  });
});
