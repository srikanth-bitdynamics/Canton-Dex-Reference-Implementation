import { afterEach, describe, expect, it, vi } from 'vitest';

import { establishSession } from '@/services/session';
import { OperatorApi } from '@/services/operator-api';
import {
  clearApiSessionCredentials,
  getApiSessionCredentials,
  getBootstrapToken,
  setBootstrapToken,
} from '@/services/api-auth';

// Control the active provider so establishSession's capability branch is
// deterministic without building the real wallet registry.
const state = vi.hoisted(() => ({
  activeProviderId: 'walletconnect' as string | null,
}));
vi.mock('@/wallet/store', () => ({
  useWalletStore: { getState: () => ({ activeProviderId: state.activeProviderId }) },
}));

afterEach(() => {
  clearApiSessionCredentials();
  state.activeProviderId = 'walletconnect';
});

describe('establishSession', () => {
  it('fetches and stores a bootstrap token; a keyless wallet does nothing more', async () => {
    state.activeProviderId = 'walletconnect'; // supportsSignMessage = false
    const paths: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      paths.push(new URL(url, 'http://test').pathname);
      if (url.endsWith('/v1/session/bootstrap')) {
        return new Response(
          JSON.stringify({ bootstrapToken: 'boot-abc', expiresAt: 9_999_999 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 501 });
    });

    const verified = await establishSession('alice::1');

    expect(verified).toBe(false); // keyless: no fast path
    expect(getBootstrapToken()).toBe('boot-abc');
    // A keyless wallet issues no challenge/verify — only the bootstrap.
    expect(paths).toContain('/v1/session/bootstrap');
    expect(paths).not.toContain('/v1/session/challenge');
    expect(paths).not.toContain('/v1/session/verify');
  });

  it('a missing session service (501) leaves no bootstrap token but does not throw', async () => {
    state.activeProviderId = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async () => new Response('{}', { status: 501 }));
    await expect(establishSession('alice::1')).resolves.toBe(false);
    expect(getBootstrapToken()).toBeUndefined();
  });
});

describe('session token wiring', () => {
  it('attaches the held bootstrap token to a swap request body', async () => {
    setBootstrapToken('boot-xyz');
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    await new OperatorApi('http://api').requestSwap({
      poolCid: 'pool1',
      swapper: 'alice::1',
      inputInstrumentId: { admin: 'ad::1', id: 'CC' },
      inputAmount: '1.0000000000',
      minOutputAmount: '0.0000000000',
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body as string;
    expect(JSON.parse(body).bootstrapToken).toBe('boot-xyz');
  });

  it('omits the bootstrap token when none is held', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    await new OperatorApi('http://api').requestSwap({
      poolCid: 'pool1',
      swapper: 'alice::1',
      inputInstrumentId: { admin: 'ad::1', id: 'CC' },
      inputAmount: '1.0000000000',
      minOutputAmount: '0.0000000000',
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body as string;
    expect('bootstrapToken' in JSON.parse(body)).toBe(false);
  });

  it('absorbs a callerToken from a settle response', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: {}, callerToken: 'party.jwt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    await new OperatorApi('http://api').settleMatchedTrade({
      tradeCid: 't1',
      allocationRequestCids: [],
    });

    expect(getApiSessionCredentials().callerToken).toBe('party.jwt');
  });
});
