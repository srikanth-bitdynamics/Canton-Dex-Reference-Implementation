import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DexContext } from '@/services/ledger';
import type { WalletIntent, WalletResult } from '@/wallet/types';

// --- mocks ----------------------------------------------------------------
//
// executeSwap branches on the active wallet provider: a party this deployment
// hosts swaps through the single testnet route (the operator signs for it and
// runs all three steps server-side), every other provider keeps the three-call
// DvP flow. We mock the wallet handoff (so no real provider/network) and the
// wallet store (which decides the branch), and record what goes on the wire.

const handToWalletMock = vi.fn<[WalletIntent], Promise<WalletResult>>();

let activeProviderId: string | null = 'testnet-hosted';

vi.mock('@/wallet/handoff', () => ({
  handToWallet: (intent: WalletIntent) => handToWalletMock(intent),
}));

vi.mock('@/wallet/store', () => ({
  useWalletStore: {
    getState: () => ({ activeProviderId, account: null }),
  },
}));

import { ledger } from '@/services/ledger';

const context: DexContext = {
  operator: 'op::1',
  lpRegistrar: 'lp::1',
  admin: 'ad::1',
  allocationFactoryCid: 'fac:1',
  settlementFactoryCid: 'set:1',
  allocationFactoryExtraArgs: { context: { values: {} }, meta: { values: {} } },
  allocationFactoryDisclosure: [],
  network: 'canton:test',
};

const pool = {
  contractId: 'pool-abc',
  baseInstrumentId: 'BTC',
  quoteInstrumentId: 'dUSD',
};

const swapParams = (swapperParty: string) => ({
  context,
  pool,
  inputInstrumentId: 'BTC',
  inputAmount: 0.1,
  minOutputAmount: 4100,
  swapperParty,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let requests: Array<{ path: string; body: Record<string, unknown> | null }> = [];

/** Stub fetch with per-path canned responses and record every request. */
function mockBackend(routes: Record<string, () => Response>) {
  requests = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://test').pathname;
      requests.push({
        path,
        body: init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : null,
      });
      const route = routes[path];
      return route ? route() : json({});
    },
  );
}

const paths = () => requests.map((r) => r.path);

beforeEach(() => {
  handToWalletMock.mockReset();
  activeProviderId = 'testnet-hosted';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executeSwap on a hosted testnet party', () => {
  it('is a single call to the testnet swap route', async () => {
    mockBackend({
      '/v1/testnet/swap': () =>
        json({
          updateId: 'update-1',
          inputAmount: '0.1000000000',
          outputAmount: '4200.0000000000',
          allocationCid: 'alloc-1',
        }),
    });

    const result = await ledger.executeSwap(swapParams('demo::1220a'));

    expect(result).toEqual({
      updateId: 'update-1',
      inputAmount: '0.1000000000',
      outputAmount: '4200.0000000000',
      allocationCid: 'alloc-1',
    });
    // No holdings read, no operator-token routes, no wallet round-trip: the
    // backend authors the input allocation itself.
    expect(paths()).toEqual(['/v1/testnet/swap']);
    expect(handToWalletMock).not.toHaveBeenCalled();
  });

  it('posts the party, pool, instrument and amounts in Canton wire shape', async () => {
    mockBackend({
      '/v1/testnet/swap': () =>
        json({
          updateId: 'update-1',
          inputAmount: '0.1000000000',
          outputAmount: '4200.0000000000',
          allocationCid: 'alloc-1',
        }),
    });

    await ledger.executeSwap(swapParams('demo::1220a'));

    expect(requests[0]!.body).toEqual({
      party: 'demo::1220a',
      poolCid: 'pool-abc',
      inputInstrumentId: 'BTC',
      inputAmount: '0.1000000000',
      minOutputAmount: '4100.0000000000',
    });
  });
});

describe('executeSwap on any other provider', () => {
  it('keeps the three-call flow untouched', async () => {
    activeProviderId = 'token-standard';
    mockBackend({
      '/v1/holdings': () =>
        json([
          {
            contractId: 'h1',
            owner: 'alice',
            admin: 'ad::1',
            instrumentId: 'BTC',
            amount: '0.1000000000',
            locked: false,
          },
        ]),
      '/v1/pools/swap/request': () =>
        json({
          allocationSpec: {},
          settlement: {},
          factoryCid: 'fac',
          allocationFactoryExtraArgs: {
            context: { values: {} },
            meta: { values: {} },
          },
          allocationFactoryDisclosure: [],
        }),
      '/v1/pools/swap': () => json({ updateId: 'settled-1' }),
    });
    handToWalletMock.mockResolvedValue({
      submittedBy: 'alice',
      primaryCid: 'alloc-1',
      createdAllocationCids: ['alloc-1'],
      auxiliaryCids: { updateId: 'update-1' },
    });

    await ledger.executeSwap(swapParams('alice'));

    expect(paths()).toContain('/v1/pools/swap/request');
    expect(paths()).toContain('/v1/pools/swap');
    expect(paths()).not.toContain('/v1/testnet/swap');
    expect(handToWalletMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'request-swap' }),
    );
    // Step 3 settles against the allocation the wallet actually authored.
    const settle = requests.find((r) => r.path === '/v1/pools/swap');
    expect(settle!.body).toMatchObject({
      poolCid: 'pool-abc',
      swapperAllocationCid: 'alloc-1',
      inputAmount: '0.1000000000',
      minOutputAmount: '4100.0000000000',
    });
  });
});

describe('hosted testnet swap errors', () => {
  const failWith = (status: number) =>
    mockBackend({
      '/v1/testnet/swap': () => json({ error: 'rejected' }, status),
    });

  it('explains a balance too small to fund the input', async () => {
    failWith(400);
    await expect(ledger.executeSwap(swapParams('demo::1220a'))).rejects.toThrow(
      /Not enough unlocked balance/,
    );
  });

  it('explains a party this deployment does not host', async () => {
    failWith(403);
    await expect(ledger.executeSwap(swapParams('demo::1220a'))).rejects.toThrow(
      /not eligible to swap here/,
    );
  });

  it('explains the daily limit', async () => {
    failWith(429);
    await expect(ledger.executeSwap(swapParams('demo::1220a'))).rejects.toThrow(
      /daily limit/,
    );
  });

  it('explains a deployment without the testnet route', async () => {
    failWith(404);
    await expect(ledger.executeSwap(swapParams('demo::1220a'))).rejects.toThrow(
      /not enabled on this deployment/,
    );
  });

  it('explains a build that has the route but has not enabled it', async () => {
    failWith(501);
    await expect(ledger.executeSwap(swapParams('demo::1220a'))).rejects.toThrow(
      /not enabled on this deployment/,
    );
  });

  it('keeps the backend wording for a ledger rejection', async () => {
    mockBackend({
      '/v1/testnet/swap': () => json({ error: 'DAML_FAILURE: slippage' }, 502),
    });
    await expect(ledger.executeSwap(swapParams('demo::1220a'))).rejects.toThrow(
      /DAML_FAILURE: slippage/,
    );
  });
});
