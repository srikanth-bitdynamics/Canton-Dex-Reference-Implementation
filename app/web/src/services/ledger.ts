// Single client surface the React pages import from. Delegates to:
//   - OperatorApi (HTTP) for orchestration calls + read queries the
//     operator can answer
//   - Wallet handoff for trader-authority writes (place order, add
//     liquidity, swap allocation creation) -- the dApp NEVER signs as
//     the trader; see docs/wallet-vs-dapp-boundary.md
//
// This file is the boundary the rest of the dApp imports from. Adding
// a new method here is an explicit, auditable extension; the React
// components below this layer should never reach past it.

import { OperatorApi } from './operator-api';
import { handToWallet } from '@/wallet/handoff';
import type {
  Order,
  Holding,
  DexPair,
  Pool as PoolType,
} from '@/types/contracts';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';

const operator = new OperatorApi(API_BASE);

/**
 * Static parties + factory cids returned by /v1/context. Required to
 * build wallet intents (the dApp does not invent operator/admin/
 * factoryCid; the operator backend owns those facts and surfaces them).
 */
export interface DexContext {
  operator: string;
  lpRegistrar: string;
  admin: string;
  allocationFactoryCid: string;
  settlementFactoryCid: string;
  network: string;
}

export interface DexStatus {
  network: string;
  slot: number;
  synced: boolean;
  serverTime: string;
}

// === read endpoints (delegate to operator HTTP API) =====================

export const ledger = {
  getContext: () => fetchJson<DexContext>('/v1/context'),
  getStatus: () => fetchJson<DexStatus>('/v1/status'),
  getPools: async (): Promise<PoolType[]> => {
    const raw = await operator.listPools();
    // Backend returns Decimal as string (Canton wire format); the UI
    // expects numbers for math + .toFixed(). Coerce on the boundary so
    // every consumer downstream stays simple.
    const num = (v: unknown): number =>
      typeof v === 'number' ? v : parseFloat(String(v ?? 0));
    const stripPrefix = (s: string): string => (s.startsWith('PS_') ? s.slice(3) : s);
    return raw.map((p) => ({
      ...p,
      status: stripPrefix(p.status as unknown as string),
      feeBps: num(p.feeBps),
      totalLpSupply: num(p.totalLpSupply),
      reserves: {
        baseAmount: num(p.reserves.baseAmount),
        quoteAmount: num(p.reserves.quoteAmount),
      },
      baseSlices: p.baseSlices.map((s) => ({
        allocationCid: s.allocationCid,
        amount: num(s.amount),
      })),
      quoteSlices: p.quoteSlices.map((s) => ({
        allocationCid: s.allocationCid,
        amount: num(s.amount),
      })),
      operatorFeeBps: p.operatorFeeBps != null ? num(p.operatorFeeBps) : null,
    })) as PoolType[];
  },
  getPairs: async (): Promise<DexPair[]> => {
    const raw = await fetchJson<DexPair[]>('/v1/pairs');
    const num = (v: unknown): number =>
      typeof v === 'number' ? v : parseFloat(String(v ?? 0));
    return raw.map((p) => ({
      ...p,
      feeModel: {
        makerFeeBps: num(p.feeModel.makerFeeBps),
        takerFeeBps: num(p.feeModel.takerFeeBps),
        poolFeeBps: num(p.feeModel.poolFeeBps),
      },
    }));
  },
  getOrders: async (trader: string): Promise<Order[]> => {
    const raw = await fetchJson<Order[]>(
      `/v1/orders?trader=${encodeURIComponent(trader)}`,
    );
    const num = (v: unknown): number =>
      typeof v === 'number' ? v : parseFloat(String(v ?? 0));
    return raw.map((o) => ({
      ...o,
      limitPrice: num(o.limitPrice),
      remainingQty: num(o.remainingQty),
    }));
  },
  getHoldings: async (owner: string): Promise<Holding[]> => {
    const raw = await fetchJson<Holding[]>(
      `/v1/holdings?owner=${encodeURIComponent(owner)}`,
    );
    const num = (v: unknown): number =>
      typeof v === 'number' ? v : parseFloat(String(v ?? 0));
    return raw.map((h) => ({ ...h, amount: num(h.amount) }));
  },

  computeSwapQuote: async (
    poolId: string,
    inputInstrumentId: string,
    inputAmount: number,
  ) => {
    const out = await operator.computeSwapQuote({
      poolId,
      inputInstrumentId,
      inputAmount: inputAmount.toString(),
    });
    return { outputAmount: parseFloat(out.outputAmount) };
  },

  // === write endpoints =====================================================
  //
  // All trader-authority writes take a `context` argument carrying the
  // operator party, asset admin, and allocation factory cid. The page
  // gets these from useQuery({ queryKey: ['context'], queryFn:
  // ledger.getContext }) and threads them through. No write function
  // here is allowed to ship blank operator/admin/factoryCid — the
  // wallet relies on those fields to build the Daml command tree.

  /**
   * Trader-authority swap. Resolves the output instrument from the pool
   * (caller passes it because the page already has the Pool object).
   */
  executeSwap: async (params: {
    context: DexContext;
    pool: { contractId: string; baseInstrumentId: string; quoteInstrumentId: string };
    inputInstrumentId: string;
    inputAmount: number;
    minOutputAmount: number;
    inputHoldingCids?: string[];
  }) => {
    const outputInstrumentId =
      params.inputInstrumentId === params.pool.baseInstrumentId
        ? params.pool.quoteInstrumentId
        : params.pool.baseInstrumentId;
    const result = await handToWallet({
      kind: 'request-swap',
      poolId: params.pool.contractId,
      inputInstrumentId: params.inputInstrumentId,
      inputAmount: params.inputAmount.toString(),
      outputInstrumentId,
      minOutputAmount: params.minOutputAmount.toString(),
      inputHoldingCids: params.inputHoldingCids ?? [],
      factoryCid: params.context.allocationFactoryCid,
      operator: params.context.operator,
      admin: params.context.admin,
    });
    return { swapRequestId: result.primaryCid };
  },

  placeOrder: async (params: {
    context: DexContext;
    pairBase: string;
    pairQuote: string;
    side: 'Bid' | 'Ask';
    limitPrice: number;
    quantity: number;
    expiry: string | null;
  }) => {
    const result = await handToWallet({
      kind: 'place-order',
      pair: { base: params.pairBase, quote: params.pairQuote },
      side: params.side,
      limitPrice: params.limitPrice.toString(),
      quantity: params.quantity.toString(),
      expiry: params.expiry,
      operator: params.context.operator,
      admin: params.context.admin,
    });
    return { orderId: result.primaryCid };
  },

  // Operator-authority write -- straight HTTP, no wallet involvement.
  cancelOrder: (orderId: string) =>
    fetchJson<void>(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
    }),

  addLiquidity: async (params: {
    context: DexContext;
    poolId: string;
    baseAmount: number;
    quoteAmount: number;
    minLpTokens: number;
    baseHoldingCids?: string[];
    quoteHoldingCids?: string[];
  }) => {
    const result = await handToWallet({
      kind: 'add-liquidity',
      poolId: params.poolId,
      baseAmount: params.baseAmount.toString(),
      quoteAmount: params.quoteAmount.toString(),
      baseHoldingCids: params.baseHoldingCids ?? [],
      quoteHoldingCids: params.quoteHoldingCids ?? [],
      minLpTokens: params.minLpTokens.toString(),
      factoryCid: params.context.allocationFactoryCid,
      operator: params.context.operator,
      admin: params.context.admin,
    });
    return { lpTokensMinted: 0, primaryCid: result.primaryCid };
  },

  // Operator-driven via /v1/pools/remove-liquidity. Slice-local: walks
  // the pool's slices from the front, cancels only the slices needed to
  // cover the redemption, and re-allocates at most ONE boundary slice
  // per side for the leftover. Creates an LPBurnRequest that the
  // trader's wallet then signs against the lpRegistrar's
  // LPTokenPolicy_AcceptBurn choice.
  //
  // Holding selection (boundaryBaseHoldingCids / boundaryQuoteHoldingCids)
  // is the operator's responsibility for the boundary-slice
  // re-allocation. Empty arrays let the operator default to discovering
  // the pool account's holdings; production deployments may want to
  // pass an explicit selection for determinism.
  removeLiquidity: async (params: {
    poolId: string;
    holder: string;
    lpTokens: number;
    knownTotalLpSupply: number;
    minBaseOut: number;
    minQuoteOut: number;
    /** LP holding the trader's wallet should lock for the burn. */
    holderLpHoldingCid?: string;
    /** LP instrument id, used in the wallet handoff hint. */
    lpInstrumentId?: string;
    boundaryBaseHoldingCids?: string[];
    boundaryQuoteHoldingCids?: string[];
  }) => {
    const result = await fetchJson<{
      poolCid: string;
      boundaryBaseAllocationCid: string | null;
      boundaryQuoteAllocationCid: string | null;
      lpBurnRequestCid: string;
      baseReturned: number;
      quoteReturned: number;
      baseSlicesConsumed: number;
      quoteSlicesConsumed: number;
    }>('/v1/pools/remove-liquidity', {
      method: 'POST',
      body: JSON.stringify({
        poolCid: params.poolId,
        holder: params.holder,
        lpTokensToRedeem: params.lpTokens.toString(),
        knownTotalLpSupply: params.knownTotalLpSupply.toString(),
        minBaseOut: params.minBaseOut.toString(),
        minQuoteOut: params.minQuoteOut.toString(),
        boundaryBaseHoldingCids: params.boundaryBaseHoldingCids ?? [],
        boundaryQuoteHoldingCids: params.boundaryQuoteHoldingCids ?? [],
        requestedAt: new Date().toISOString(),
      }),
    });

    // Trader-side LP burn handoff: the wallet exercises
    // LPBurnRequest_AcceptAndBurn against the request the operator just
    // created, archiving the trader's locked LP holding. If the caller
    // didn't supply a holding cid the dApp can't drive this leg; fall
    // back to surfacing the burn-request cid so the trader can complete
    // it from their wallet manually.
    if (params.holderLpHoldingCid && params.lpInstrumentId) {
      await handToWallet(
        {
          kind: 'accept-lp-burn',
          burnRequestCid: result.lpBurnRequestCid,
          holderHoldingCid: params.holderLpHoldingCid,
          hint: {
            lpInstrumentId: params.lpInstrumentId,
            amount: params.lpTokens.toString(),
          },
        },
        { preferPostMessage: true },
      );
    }
    return result;
  },
};

// Direct export for callers that want the typed OperatorApi handle
// (e.g., the wired SwapCard).
export const operatorApi = operator;

// === local fetch helper for endpoints OperatorApi doesn't typed-wrap ====

async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
