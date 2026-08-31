// Orchestration test for the RFQ settle-through flow (ledger.settleMatchedTrade):
// request the trader's TradeAllocationRequest, fund + author its per-admin
// allocations through the wallet, and settle the cross-admin batches.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// No wallet connected in the store, so holdings come from the operator read and
// funding never routes through an admin-co-signed split/merge.
vi.mock('@/wallet/store', () => ({
  useWalletStore: {
    getState: () => ({ activeProviderId: null, account: { party: 'alice::1220a' } }),
  },
}));
vi.mock('@/wallet/handoff', () => ({ handToWallet: vi.fn() }));

import { ledger } from '@/services/ledger';
import { handToWallet } from '@/wallet/handoff';

const trader = 'alice::1220a';
const meta = { values: {} };
const authorizer = { owner: trader, provider: null, id: '' };
const dealerSide = { owner: 'dealer::1', provider: null, id: '' };

// A cross-admin buy: the trader sends USDCx@usdc-admin (sender leg, funded) and
// receives Amulet@cc-admin (receiver leg, funds nothing).
function crossAdminRequest() {
  return {
    requestCid: 'tradeReq-1',
    settlement: { executors: ['op::1'], id: 'MatchedTrade', cid: 'trade-1', meta },
    requestedAt: '2026-05-19T12:00:00.000Z',
    allocations: [
      {
        admin: 'usdc-admin',
        authorizer,
        transferLegSides: [
          {
            transferLegId: 'leg-quote',
            side: 'SenderSide',
            otherside: dealerSide,
            amount: '1000.0000000000',
            instrumentId: 'USDCx',
            meta,
          },
        ],
        settlementDeadline: null,
        nextIterationFunding: null,
        committed: false,
        meta,
      },
      {
        admin: 'cc-admin',
        authorizer,
        transferLegSides: [
          {
            transferLegId: 'leg-base',
            side: 'ReceiverSide',
            otherside: dealerSide,
            amount: '0.1000000000',
            instrumentId: 'Amulet',
            meta,
          },
        ],
        settlementDeadline: null,
        nextIterationFunding: null,
        committed: false,
        meta,
      },
    ],
  };
}

// The dealer's own request for the same trade: it sends Amulet@cc-admin and
// receives USDCx@usdc-admin. Only the dealer's session can author these.
function dealerRequest() {
  return {
    requestCid: 'tradeReq-2',
    settlement: { executors: ['op::1'], id: 'MatchedTrade', cid: 'trade-1', meta },
    requestedAt: '2026-05-19T12:00:00.000Z',
    allocations: [
      {
        admin: 'cc-admin',
        authorizer: dealerSide,
        transferLegSides: [
          {
            transferLegId: 'leg-base',
            side: 'SenderSide',
            otherside: authorizer,
            amount: '0.1000000000',
            instrumentId: 'Amulet',
            meta,
          },
        ],
        settlementDeadline: null,
        nextIterationFunding: null,
        committed: false,
        meta,
      },
    ],
  };
}

interface CapturedFetch {
  settleBody: Record<string, unknown> | null;
  factoryCalls: number;
}

function mockFetch(
  requestAllocations: unknown | unknown[],
  holdings: unknown[],
): CapturedFetch {
  const captured: CapturedFetch = { settleBody: null, factoryCalls: 0 };
  const requests = Array.isArray(requestAllocations)
    ? requestAllocations
    : [requestAllocations];
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = new URL(url, 'http://test').pathname;
    if (path === '/v1/matched-trades/request-allocations') {
      return json({ allocationRequests: requests });
    }
    if (path === '/v1/pairs') return json([]);
    if (path === '/v1/holdings') return json(holdings);
    if (path === '/v1/registry/allocation-factory') {
      captured.factoryCalls += 1;
      return json({
        factoryCid: 'factory-x',
        extraArgs: { context: { values: {} }, meta: { values: {} } },
        disclosure: [],
      });
    }
    if (path === '/v1/matched-trades/settle') {
      captured.settleBody = JSON.parse(String(init?.body ?? '{}'));
      return json({ result: 'ok' });
    }
    return json({});
  });
  return captured;
}

describe('settleMatchedTrade', () => {
  beforeEach(() => {
    vi.mocked(handToWallet).mockReset();
  });

  it('funds the trader side and settles cross-admin batches grouped by admin', async () => {
    const captured = mockFetch(crossAdminRequest(), [
      { contractId: 'h-usdc', owner: trader, admin: 'usdc-admin', instrumentId: 'USDCx', amount: 5000, locked: false },
    ]);
    vi.mocked(handToWallet).mockResolvedValue({
      submittedBy: trader,
      primaryCid: 'update-x',
      createdAllocationCids: ['alloc-usdc', 'alloc-cc'],
      auxiliaryCids: {},
    });

    await ledger.settleMatchedTrade({ tradeCid: 'trade-1', trader });

    expect(handToWallet).toHaveBeenCalledTimes(1);
    const intent = vi.mocked(handToWallet).mock.calls[0]![0];
    expect(intent.kind).toBe('fund-matched-trade');
    if (intent.kind !== 'fund-matched-trade') throw new Error('wrong intent');
    // Both specs authored; a factory discovered per admin.
    expect(intent.allocations).toHaveLength(2);
    expect(captured.factoryCalls).toBe(2);
    // Only the USDCx sender spec draws holdings; the Amulet receiver locks none.
    expect(intent.inputHoldingCids).toEqual(['h-usdc']);
    // The created cids settle, grouped by their spec's admin.
    expect(captured.settleBody?.tradeCid).toBe('trade-1');
    expect(captured.settleBody?.allocationCidsByAdmin).toEqual({
      'usdc-admin': ['alloc-usdc'],
      'cc-admin': ['alloc-cc'],
    });
    // The wallet accept archived the trader's request, so none is consumed here.
    expect(captured.settleBody?.allocationRequestCids).toEqual([]);
  });

  it('settles via updateId when the wallet returns no created cids', async () => {
    const captured = mockFetch(crossAdminRequest(), [
      { contractId: 'h-usdc', owner: trader, admin: 'usdc-admin', instrumentId: 'USDCx', amount: 5000, locked: false },
    ]);
    vi.mocked(handToWallet).mockResolvedValue({
      submittedBy: trader,
      primaryCid: 'update-only',
      auxiliaryCids: { updateId: 'update-only' },
    });

    await ledger.settleMatchedTrade({ tradeCid: 'trade-1', trader });

    expect(captured.settleBody?.updateId).toBe('update-only');
    expect(captured.settleBody?.allocationCidsByAdmin).toBeUndefined();
  });

  it('rejects when the trader cannot cover the sender leg', async () => {
    mockFetch(crossAdminRequest(), [
      { contractId: 'h-usdc', owner: trader, admin: 'usdc-admin', instrumentId: 'USDCx', amount: 10, locked: false },
    ]);
    await expect(
      ledger.settleMatchedTrade({ tradeCid: 'trade-1', trader }),
    ).rejects.toThrow(/insufficient unlocked USDCx/);
  });

  it('funds its own side but does not settle with only one side when a counterparty request exists', async () => {
    // A real two-party RFQ: the operator returns both the trader's and the
    // dealer's requests. This session can author only the trader's side, so it
    // funds that and stops rather than settling the dealer's admin uncovered.
    const captured = mockFetch(
      [crossAdminRequest(), dealerRequest()],
      [
        { contractId: 'h-usdc', owner: trader, admin: 'usdc-admin', instrumentId: 'USDCx', amount: 5000, locked: false },
      ],
    );
    vi.mocked(handToWallet).mockResolvedValue({
      submittedBy: trader,
      primaryCid: 'update-x',
      createdAllocationCids: ['alloc-usdc', 'alloc-cc'],
      auxiliaryCids: {},
    });

    await expect(
      ledger.settleMatchedTrade({ tradeCid: 'trade-1', trader }),
    ).rejects.toThrow(/counterparty has not funded/);

    // The trader's side WAS funded (as much as this session correctly can)...
    expect(handToWallet).toHaveBeenCalledTimes(1);
    // ...but no partial settlement was attempted.
    expect(captured.settleBody).toBeNull();
  });
});
