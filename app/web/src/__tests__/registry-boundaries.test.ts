import { beforeEach, describe, expect, it } from "vitest";

import { getProviders } from "@/wallet/registry";

describe("wallet registry authority boundaries", () => {
  beforeEach(() => {
    window.localStorage.setItem(
      "canton-dex:direct:session",
      JSON.stringify({ token: "legacy-participant-secret" }),
    );
  });

  it("never registers Direct Canton and removes its legacy bearer session", () => {
    expect([...getProviders().keys()]).not.toContain("canton-direct");
    expect(window.localStorage.getItem("canton-dex:direct:session")).toBeNull();
  });
});
