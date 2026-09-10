import { describe, it, expect, vi } from "vitest";
import {
  ACS_RETRY_DELAYS_MS,
  isRateLimited,
  withAcsRetry,
} from "@/wallet/partylayer-provider";

describe("isRateLimited", () => {
  it("recognizes a surfaced 429 status", () => {
    expect(
      isRateLimited(new Error("Failed to get active contracts: 429 : null")),
    ).toBe(true);
  });

  it("recognizes textual rate-limit signals", () => {
    expect(isRateLimited(new Error("Too Many Requests"))).toBe(true);
    expect(isRateLimited(new Error("rate limit exceeded"))).toBe(true);
  });

  it("does not treat other failures as rate limits", () => {
    expect(isRateLimited(new Error("PACKAGE_NAMES_NOT_FOUND"))).toBe(false);
    expect(isRateLimited(new Error("INVALID_PRESCRIBED_SYNCHRONIZER_ID"))).toBe(false);
    expect(isRateLimited(new Error("boundary4290"))).toBe(false);
  });
});

describe("withAcsRetry", () => {
  const noSleep = async () => {};

  it("returns immediately on success without retrying", async () => {
    const op = vi.fn(async () => "ok");
    const result = await withAcsRetry(op, ACS_RETRY_DELAYS_MS, noSleep);
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limited read until it succeeds", async () => {
    let calls = 0;
    const op = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("Failed to get active contracts: 429 : null");
      return "recovered";
    });
    const slept: number[] = [];
    const result = await withAcsRetry(op, [10, 20, 30], async (ms) => {
      slept.push(ms);
    });
    expect(result).toBe("recovered");
    expect(op).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([10, 20]);
  });

  it("gives up after exhausting the backoff schedule", async () => {
    const op = vi.fn(async () => {
      throw new Error("429 too many");
    });
    await expect(withAcsRetry(op, [1, 2], noSleep)).rejects.toThrow(/429/);
    expect(op).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry a non-rate-limit error", async () => {
    const op = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(withAcsRetry(op, [1, 2], noSleep)).rejects.toThrow("boom");
    expect(op).toHaveBeenCalledTimes(1);
  });
});
