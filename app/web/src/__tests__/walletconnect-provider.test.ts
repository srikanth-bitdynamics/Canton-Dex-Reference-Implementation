import { describe, expect, it, vi } from 'vitest';

import {
  WalletConnectProvider,
  WalletStatusUnknownError,
} from '@/wallet/walletconnect-provider';
import type { WalletIntent } from '@/wallet/types';

const swapIntent = {
  kind: 'request-swap',
  poolId: 'pool-1',
} as unknown as WalletIntent;

// Inject a fake connector + connected status without driving the AppKit import.
// `request` is a vitest mock; typed `any` so each test can return whatever
// shape it needs without fighting vitest's Mock variance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function connectedProvider(request: any) {
  const p = new WalletConnectProvider('proj', 'canton:devnet');
  const fakeConnector = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    request,
    on: vi.fn(),
    off: vi.fn(),
  };
  // Private fields — set them directly for the test.
  (p as unknown as { connector: unknown }).connector = fakeConnector;
  (p as unknown as { status: unknown }).status = {
    kind: 'connected',
    account: { party: 'alice' },
    providerId: 'walletconnect',
  };
  return { p, request, fakeConnector };
}

describe('WalletConnectProvider submit retry safety', () => {
  it('does NOT retry a submit on timeout — surfaces status-unknown', async () => {
    vi.useFakeTimers();
    // request never resolves -> withTimeout rejects with "timed out".
    const request = vi.fn(() => new Promise(() => {}));
    const { p } = connectedProvider(request);

    // Attach the rejection handler up front so the rejection is never orphaned
    // while the fake timer advances.
    let captured: unknown;
    const submit = p.submit(swapIntent).catch((e) => {
      captured = e;
    });
    // Drive the 30s submit timeout.
    await vi.advanceTimersByTimeAsync(31_000);
    await submit;

    expect(captured).toBeInstanceOf(WalletStatusUnknownError);
    // Critical: the wallet was asked to authorize exactly once. No auto-retry
    // (which would risk a duplicate authorization).
    expect(request).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('threads a commandId idempotency key into the submit params', async () => {
    const request = vi.fn(async () => ({
      submittedBy: 'alice',
      primaryCid: 'cid-1',
    }));
    const { p } = connectedProvider(request);

    await p.submit(swapIntent);

    expect(request).toHaveBeenCalledTimes(1);
    const arg = (request.mock.calls as unknown[][])[0]![0] as {
      method: string;
      params: Array<{ commandId?: string }>;
    };
    expect(arg.method).toBe('canton_prepareExecute');
    expect(arg.params[0]!.commandId).toMatch(/^wc-request-swap-/);
  });

  it('propagates non-timeout errors unchanged (e.g. user reject)', async () => {
    const request = vi.fn(async () => {
      throw new Error('user rejected request');
    });
    const { p } = connectedProvider(request);

    await expect(p.submit(swapIntent)).rejects.toThrow('user rejected');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
