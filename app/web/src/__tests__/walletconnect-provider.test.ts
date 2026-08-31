import { describe, expect, it, vi } from 'vitest';

import {
  WalletConnectProvider,
  WalletStatusUnknownError,
} from '@/wallet/walletconnect-provider';
import type { PlaceOrderIntent } from '@/wallet/types';

const placeOrderIntent: PlaceOrderIntent = {
  kind: 'place-order',
  pair: {
    base: { admin: 'admin::1220a', id: 'Amulet' },
    quote: { admin: 'admin::1220a', id: 'USDCx' },
  },
  side: 'Bid',
  limitPrice: '20000.0000000000',
  quantity: '0.1000000000',
  expiry: null,
  operator: 'operator::1220a',
};

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
    const submit = p.submit(placeOrderIntent).catch((e) => {
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

    await p.submit(placeOrderIntent);

    expect(request).toHaveBeenCalledTimes(1);
    const arg = (request.mock.calls as unknown[][])[0]![0] as {
      method: string;
      params: Array<{ commandId?: string }>;
    };
    expect(arg.method).toBe('canton_prepareExecute');
    expect(arg.params[0]!.commandId).toMatch(/^wc-place-order-/);
  });

  it('propagates non-timeout errors unchanged (e.g. user reject)', async () => {
    const request = vi.fn(async () => {
      throw new Error('user rejected request');
    });
    const { p } = connectedProvider(request);

    await expect(p.submit(placeOrderIntent)).rejects.toThrow('user rejected');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('WalletConnectProvider holding discovery', () => {
  it('discovers a foreign-registry holding via canton_ledgerApi across both filters', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = vi.fn(async (args: any) => {
      expect(args.method).toBe('canton_ledgerApi');
      const params = args.params[0] as { requestMethod: string; resource: string; body?: string };
      if (params.resource === '/v2/state/ledger-end') {
        expect(params.requestMethod).toBe('GET');
        return { offset: 7 };
      }
      expect(params.resource).toBe('/v2/state/active-contracts');
      expect(params.requestMethod).toBe('POST');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = JSON.parse(params.body ?? '{}') as any;
      const identifierFilter =
        body.filter.filtersByParty['alice'].cumulative[0].identifierFilter;
      if (identifierFilter.InterfaceFilter) {
        return {
          activeContracts: [
            {
              contractId: 'holding-amulet',
              interfaceViews: [
                {
                  interfaceId:
                    '#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding',
                  viewValue: {
                    account: { owner: 'alice', provider: null, id: '' },
                    instrumentId: { admin: 'cc-admin', id: 'Amulet' },
                    amount: '2.0000000000',
                    lock: null,
                  },
                },
              ],
            },
          ],
        };
      }
      return {
        activeContracts: [
          {
            contractId: 'holding-usdcx',
            createArgument: {
              owner: 'alice',
              admin: 'dex-admin',
              instrumentId: 'USDCx',
              amount: '9.0000000000',
              locked: false,
            },
          },
        ],
      };
    });
    const { p } = connectedProvider(request);

    const holdings = await p.listHoldings('alice');

    // ledger-end fetched, then one active-contracts read per filter.
    expect(request).toHaveBeenCalledTimes(3);
    const acsBodies = (request.mock.calls as unknown[][])
      .map((c) => (c[0] as { params: [{ resource: string; body?: string }] }).params[0])
      .filter((p) => p.resource === '/v2/state/active-contracts')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((p) => JSON.parse(p.body ?? '{}') as any);
    expect(acsBodies).toHaveLength(2);
    for (const b of acsBodies) {
      expect(b.activeAtOffset).toBe(7);
      expect(Object.keys(b.filter.filtersByParty)).toEqual(['alice']);
    }
    const identifierFilters = acsBodies.map(
      (b) => b.filter.filtersByParty['alice'].cumulative[0].identifierFilter,
    );
    expect(
      identifierFilters.some(
        (f) =>
          f.InterfaceFilter?.value?.interfaceId ===
          '#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding',
      ),
    ).toBe(true);
    expect(
      identifierFilters.some(
        (f) =>
          f.TemplateFilter?.value?.templateId ===
          '#canton-dex-trading-v2:CantonDex.Registry.V2:Holding',
      ),
    ).toBe(true);
    expect(holdings).toEqual([
      {
        contractId: 'holding-amulet',
        owner: 'alice',
        admin: 'cc-admin',
        instrumentId: 'Amulet',
        amount: 2,
        amountRaw: '2.0000000000',
        locked: false,
      },
      {
        contractId: 'holding-usdcx',
        owner: 'alice',
        admin: 'dex-admin',
        instrumentId: 'USDCx',
        amount: 9,
        amountRaw: '9.0000000000',
        locked: false,
      },
    ]);
  });
});
