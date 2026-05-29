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
import { useWalletStore } from '@/wallet/store';
import type { V2AllocationSpecification, V2SettlementInfo } from '@/wallet/types';
import type {
  Order,
  Holding,
  DexPair,
  Pool as PoolType,
} from '@/types/contracts';

// Shapes of the operator-backend DvP /request responses (DEX-53/54).
interface RequestAddResult {
  requestCid: string;
  lpAmount: string;
  knownTotalLpSupply: string;
  baseAmount: string;
  quoteAmount: string;
  allocations: V2AllocationSpecification[];
  settlement: V2SettlementInfo;
  depositFactoryCid: string;
  lpFactoryCid: string;
}
interface RequestRemoveResult {
  requestCid: string;
  knownTotalLpSupply: string;
  baseSliceCids: string[];
  quoteSliceCids: string[];
  baseOuts: string[];
  quoteOuts: string[];
  allocations: V2AllocationSpecification[];
  settlement: V2SettlementInfo;
  depositFactoryCid: string;
  lpFactoryCid: string;
}

function connectedParty(): string {
  const party = useWalletStore.getState().account?.party;
  if (!party) throw new Error('connect a wallet before providing liquidity');
  return party;
}

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

  // DvP add (DEX-54), two calls around one wallet submission:
  //   1. operator creates the LiquidityAllocationRequest (/request);
  //   2. the trader's wallet authors the 3 allocations the request names;
  //   3. operator + lpRegistrar settle with the created cids (/settle).
  // For the self-registry admin == lpRegistrar, so one factory backs both
  // the deposit (pool.admin) and LP-receipt (pool.lpRegistrar) legs.
  addLiquidity: async (params: {
    context: DexContext;
    poolId: string;
    baseAmount: number;
    quoteAmount: number;
    minLpTokens: number;
    baseHoldingCids?: string[];
    quoteHoldingCids?: string[];
  }) => {
    const recipient = connectedParty();
    const requestedAt = new Date().toISOString();
    const req = await fetchJson<RequestAddResult>('/v1/pools/add-liquidity/request', {
      method: 'POST',
      body: JSON.stringify({
        poolCid: params.poolId,
        recipient,
        baseAmount: params.baseAmount.toString(),
        quoteAmount: params.quoteAmount.toString(),
        requestedAt,
      }),
    });
    const walletRes = await handToWallet({
      kind: 'add-liquidity',
      requestCid: req.requestCid,
      settlement: req.settlement,
      allocations: req.allocations,
      // Distinct factories per admin (deposits under pool.admin, LP receipt
      // under pool.lpRegistrar) — both come from /request, not context.
      depositFactoryCid: req.depositFactoryCid,
      lpFactoryCid: req.lpFactoryCid,
      baseHoldingCids: params.baseHoldingCids ?? [],
      quoteHoldingCids: params.quoteHoldingCids ?? [],
    });
    const cids = walletRes.createdAllocationCids;
    if (!cids || cids.length !== 3) {
      throw new Error('wallet did not return the 3 created allocation cids for add-liquidity');
    }
    const [lpBaseDepositCid, lpQuoteDepositCid, lpReceiptCid] = cids;
    await fetchJson('/v1/pools/add-liquidity/settle', {
      method: 'POST',
      body: JSON.stringify({
        poolCid: params.poolId,
        requestCid: req.requestCid,
        recipient,
        lpBaseDepositCid,
        lpQuoteDepositCid,
        lpReceiptCid,
        baseAmount: req.baseAmount,
        quoteAmount: req.quoteAmount,
        minLpTokens: params.minLpTokens.toString(),
        knownTotalLpSupply: req.knownTotalLpSupply,
        requestedAt,
      }),
    });
    return { lpTokensMinted: Number(req.lpAmount), primaryCid: req.requestCid };
  },

  // DvP remove (DEX-54), symmetric to add: the operator derives the slice
  // draw + creates the request; the trader's wallet authors the base/quote
  // receipts + the LP burn-sender (locking `holderLpHoldingCid`); the
  // operator + lpRegistrar settle, delivering base+quote to the holder and
  // burning the LP tokens. `holderLpHoldingCid` is required — the wallet
  // must lock a concrete LP holding for the burn.
  removeLiquidity: async (params: {
    context: DexContext;
    poolId: string;
    holder: string;
    lpTokens: number;
    minBaseOut: number;
    minQuoteOut: number;
    /** ALL the trader's unlocked LP holdings to lock for the burn (an LP
     *  position can be split across several holdings). Must be non-empty. */
    holderLpHoldingCids: string[];
  }) => {
    if (params.holderLpHoldingCids.length === 0) {
      throw new Error('no unlocked LP holdings to burn');
    }
    const requestedAt = new Date().toISOString();
    const req = await fetchJson<RequestRemoveResult>('/v1/pools/remove-liquidity/request', {
      method: 'POST',
      body: JSON.stringify({
        poolCid: params.poolId,
        holder: params.holder,
        lpTokensToRedeem: params.lpTokens.toString(),
        requestedAt,
      }),
    });
    const walletRes = await handToWallet({
      kind: 'remove-liquidity',
      requestCid: req.requestCid,
      settlement: req.settlement,
      allocations: req.allocations,
      depositFactoryCid: req.depositFactoryCid,
      lpFactoryCid: req.lpFactoryCid,
      lpHoldingCids: params.holderLpHoldingCids,
    });
    const cids = walletRes.createdAllocationCids;
    if (!cids || cids.length !== 3) {
      throw new Error('wallet did not return the 3 created allocation cids for remove-liquidity');
    }
    const [holderBaseReceiptCid, holderQuoteReceiptCid, holderBurnSenderCid] = cids;
    return fetchJson<{ result: unknown }>('/v1/pools/remove-liquidity/settle', {
      method: 'POST',
      body: JSON.stringify({
        poolCid: params.poolId,
        requestCid: req.requestCid,
        holder: params.holder,
        lpTokensToRedeem: params.lpTokens.toString(),
        knownTotalLpSupply: req.knownTotalLpSupply,
        minBaseOut: params.minBaseOut.toString(),
        minQuoteOut: params.minQuoteOut.toString(),
        holderBaseReceiptCid,
        holderQuoteReceiptCid,
        holderBurnSenderCid,
        requestedAt,
      }),
    });
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
