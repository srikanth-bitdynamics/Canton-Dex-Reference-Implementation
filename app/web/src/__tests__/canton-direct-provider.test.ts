import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CANTON_DIRECT_DISABLED_MESSAGE,
  CantonDirectProvider,
} from "@/wallet/canton-direct-provider";

describe("disabled Direct Canton experiment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed without sending a bearer credential or network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new CantonDirectProvider(
      "https://participant.example",
      "must-not-be-used",
    );

    await expect(provider.connect()).rejects.toThrow(
      CANTON_DIRECT_DISABLED_MESSAGE,
    );
    expect(provider.getStatus()).toEqual({
      kind: "error",
      message: CANTON_DIRECT_DISABLED_MESSAGE,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
