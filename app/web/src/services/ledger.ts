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
import type {
  ContractId,
  DisclosedContract,
  V2AllocationSpecification,
  V2ExtraArgs,
  V2SettlementInfo,
} from '@/wallet/types';
import type {
  Order,
  Holding,
  DexPair,
  Pool as PoolType,
} from '@/types/contracts';

// Shapes of the operator-backend DvP /request responses.
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
  depositFactoryExtraArgs: V2ExtraArgs;
  lpFactoryExtraArgs: V2ExtraArgs;
  depositFactoryDisclosure: DisclosedContract[];
  lpFactoryDisclosure: DisclosedContract[];
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
  depositFactoryExtraArgs: V2ExtraArgs;
  lpFactoryExtraArgs: V2ExtraArgs;
  depositFactoryDisclosure: DisclosedContract[];
  lpFactoryDisclosure: DisclosedContract[];
}

function connectedParty(): string {
  const party = useWalletStore.getState().account?.party;
  if (!party) throw new Error('connect a wallet before providing liquidity');
  return party;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';

const operator = new OperatorApi(API_BASE);

export function formatDecimal10(value: number): string {
  return value.toFixed(10);
}

function multiplyDecimal10(left: number, right: number): string {
  const scaled = decimal10Units(left) * decimal10Units(right);
  return unitsToDecimal10(scaled / 10_000_000_000n);
}

function decimal10Units(value: number): bigint {
  const [whole, frac = ''] = formatDecimal10(value).split('.');
  return BigInt(`${whole}${frac.padEnd(10, '0')}`);
}

function decimal10StringUnits(value: string): bigint {
  const trimmed = value.trim();
  const sign = trimmed.startsWith('-') ? -1n : 1n;
  const unsigned = trimmed.replace(/^[+-]/, '');
  const [whole = '0', frac = ''] = unsigned.split('.');
  return sign * BigInt(`${whole}${frac.padEnd(10, '0').slice(0, 10)}`);
}

function unitsToDecimal10(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const whole = abs / 10_000_000_000n;
  const frac = (abs % 10_000_000_000n).toString().padStart(10, '0');
  return `${sign}${whole.toString()}.${frac}`;
}

interface FundingHolding {
  contractId: string;
  units: bigint;
}

type SwapFundingPlan =
  | { kind: 'exact'; holdingCids: string[] }
  | { kind: 'split'; sourceHoldingCid: string; splitAmount: string }
  | {
      kind: 'merge-then-split';
      primaryHoldingCid: string;
      otherHoldingCids: string[];
      splitAmount: string;
    }
  | { kind: 'insufficient' };

function unlockedInstrumentHoldings(
  holdings: Holding[],
  instrumentId: string,
  admin?: string,
): FundingHolding[] {
  return holdings
    .filter(
      (h) =>
        h.instrumentId === instrumentId &&
        !h.locked &&
        (admin == null || h.admin === admin),
    )
    .map((h) => ({
      contractId: h.contractId,
      units: decimal10Units(h.amount),
    }))
    .filter((h) => h.units > 0n);
}

export function planSwapFunding(
  holdings: Holding[],
  instrumentId: string,
  targetAmount: number | string,
  admin?: string,
): SwapFundingPlan {
  const exact = pickExactHoldingCids(holdings, instrumentId, targetAmount, admin);
  if (exact) return { kind: 'exact', holdingCids: exact };

  const target =
    typeof targetAmount === 'string'
      ? decimal10StringUnits(targetAmount)
      : decimal10Units(targetAmount);
  const candidates = unlockedInstrumentHoldings(holdings, instrumentId, admin);
  const total = candidates.reduce((sum, h) => sum + h.units, 0n);
  if (total < target) return { kind: 'insufficient' };

  const smallestOversized = [...candidates]
    .filter((h) => h.units > target)
    .sort((a, b) => Number(a.units - b.units))[0];
  if (smallestOversized) {
    return {
      kind: 'split',
      sourceHoldingCid: smallestOversized.contractId,
      splitAmount: unitsToDecimal10(target),
    };
  }

  const descending = [...candidates].sort((a, b) => Number(b.units - a.units));
  const picked: FundingHolding[] = [];
  let accumulated = 0n;
  for (const holding of descending) {
    picked.push(holding);
    accumulated += holding.units;
    if (accumulated >= target) break;
  }
  if (picked.length === 0 || accumulated < target) {
    return { kind: 'insufficient' };
  }
  return {
    kind: 'merge-then-split',
    primaryHoldingCid: picked[0]!.contractId,
    otherHoldingCids: picked.slice(1).map((h) => h.contractId),
    splitAmount: unitsToDecimal10(target),
  };
}

export function pickExactHoldingCids(
  holdings: Holding[],
  instrumentId: string,
  targetAmount: number | string,
  admin?: string,
): string[] | null {
  const target =
    typeof targetAmount === 'string'
      ? decimal10StringUnits(targetAmount)
      : decimal10Units(targetAmount);
  if (target <= 0n) return [];
  const candidates = holdings
    .filter(
      (h) =>
        h.instrumentId === instrumentId &&
        !h.locked &&
        (admin == null || h.admin === admin),
    )
    .map((h) => ({
      contractId: h.contractId,
      units: decimal10Units(h.amount),
    }))
    .filter((h) => h.units > 0n)
    .sort((a, b) => Number(a.units - b.units));

  const chosen: string[] = [];
  const seen = new Set<string>();

  function search(start: number, remaining: bigint): boolean {
    if (remaining === 0n) return true;
    const key = `${start}:${remaining}`;
    if (seen.has(key)) return false;
    seen.add(key);
    for (let i = start; i < candidates.length; i += 1) {
      const candidate = candidates[i]!;
      if (candidate.units > remaining) continue;
      chosen.push(candidate.contractId);
      if (search(i + 1, remaining - candidate.units)) return true;
      chosen.pop();
    }
    return false;
  }

  return search(0, target) ? [...chosen] : null;
}

async function normalizeSwapFunding(params: {
  admin: string;
  party: string;
  instrumentId: string;
  amount: number | string;
}): Promise<string[] | null> {
  let holdings = await ledger.getHoldings(params.party);
  let plan = planSwapFunding(
    holdings,
    params.instrumentId,
    params.amount,
    params.admin,
  );
  if (plan.kind === 'exact') return plan.holdingCids;
  if (plan.kind === 'insufficient') return null;

  if (plan.kind === 'split') {
    await handToWallet({
      kind: 'split-holding',
      holdingCid: plan.sourceHoldingCid,
      admin: params.admin,
      splitAmount: plan.splitAmount,
    });
    holdings = await ledger.getHoldings(params.party);
    return pickExactHoldingCids(
      holdings,
      params.instrumentId,
      params.amount,
      params.admin,
    );
  }

  let currentCid = plan.primaryHoldingCid;
  for (const otherCid of plan.otherHoldingCids) {
    const result = await handToWallet({
      kind: 'merge-holdings',
      holdingCid: currentCid,
      otherCid,
      admin: params.admin,
    });
    currentCid = result.createdHoldingCids?.[0] ?? currentCid;
  }
  await handToWallet({
    kind: 'split-holding',
    holdingCid: currentCid,
    admin: params.admin,
    splitAmount: plan.splitAmount,
  });
  holdings = await ledger.getHoldings(params.party);
  return pickExactHoldingCids(
    holdings,
    params.instrumentId,
    params.amount,
    params.admin,
  );
}

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
  allocationFactoryExtraArgs: V2ExtraArgs;
  allocationFactoryDisclosure: DisclosedContract[];
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
  // Swap/order writes still take a `context` argument carrying the operator
  // party, asset admin, and allocation factory cid. DvP add/remove fetch
  // the factories they need from `/request`.

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
    swapperParty: string;
    inputHoldingCids?: string[];
  }) => {
    // Three-call DvP swap: (1) the operator builds the swapper's input
    // allocation spec in Daml (PoolRules_RequestSwap); (2) the wallet authors
    // that single allocation, locking the trader's input holdings, and returns
    // the created Allocation cid; (3) the operator settles via PoolRules_Swap
    // with that cid. The promise resolves on the real settle result — no
    // optimistic success.
    let inputHoldingCids = params.inputHoldingCids;
    if (!inputHoldingCids || inputHoldingCids.length === 0) {
      inputHoldingCids = await normalizeSwapFunding({
        admin: params.context.admin,
        party: params.swapperParty,
        instrumentId: params.inputInstrumentId,
        amount: params.inputAmount,
      }) ?? undefined;
    }
    if (!inputHoldingCids || inputHoldingCids.length === 0) {
      throw new Error(
        `swap: unable to prepare an exact ${params.inputInstrumentId} funding holding for ${formatDecimal10(params.inputAmount)}`,
      );
    }

    // 1. Operator-built allocation spec + settlement.
    const req = await operator.requestSwap({
      poolCid: params.pool.contractId as ContractId<'Pool'>,
      swapper: params.swapperParty,
      inputInstrumentId: params.inputInstrumentId,
      inputAmount: formatDecimal10(params.inputAmount),
    });

    // 2. Wallet authors the single prefunded input allocation.
    const walletResult = await handToWallet({
      kind: 'request-swap',
      poolId: params.pool.contractId,
      allocationSpec: req.allocationSpec as V2AllocationSpecification,
      settlement: req.settlement as V2SettlementInfo,
      factoryCid: req.factoryCid,
      allocationFactoryExtraArgs: req.allocationFactoryExtraArgs,
      disclosure: req.allocationFactoryDisclosure,
      inputHoldingCids: inputHoldingCids as ContractId<'Holding'>[],
    });
    const swapperAllocationCid = walletResult.createdAllocationCids?.[0];
    if (!swapperAllocationCid) {
      throw new Error(
        'swap: wallet did not return the created allocation cid; this provider cannot drive the swap',
      );
    }

    // 3. Operator settles the swap against the authored allocation.
    return operator.swap({
      poolCid: params.pool.contractId as ContractId<'Pool'>,
      swapperAccount: { owner: params.swapperParty, provider: null, id: '' },
      inputInstrumentId: params.inputInstrumentId,
      inputAmount: formatDecimal10(params.inputAmount),
      minOutputAmount: formatDecimal10(params.minOutputAmount),
      swapperAllocationCid: swapperAllocationCid as ContractId<'Allocation'>,
    });
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
    const trader = connectedParty();
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
    const settlementRef = `web-${Date.now()}`;
    const bindRes = await operator.bindOrder({
      fundingRequestCid: result.primaryCid as ContractId<'OrderFundingRequest'>,
      settlementRef,
    });

    const lockInstrumentId =
      params.side === 'Bid' ? params.pairQuote : params.pairBase;
    const lockAmount =
      params.side === 'Bid'
        ? multiplyDecimal10(params.limitPrice, params.quantity)
        : formatDecimal10(params.quantity);
    const inputHoldingCids = await normalizeSwapFunding({
      admin: params.context.admin,
      party: trader,
      instrumentId: lockInstrumentId,
      amount: lockAmount,
    });
    if (!inputHoldingCids || inputHoldingCids.length === 0) {
      throw new Error(
        `order funding: no exact unlocked ${lockInstrumentId} holdings cover ${lockAmount}; split holdings first`,
      );
    }

    const walletRes = await handToWallet({
      kind: 'accept-allocation-request',
      requestCid: bindRes.allocationRequestCid as ContractId<'AllocationRequest'>,
      factoryCid: params.context.allocationFactoryCid as ContractId<'AllocationFactory'>,
      allocationRequestExtraArgs: params.context.allocationFactoryExtraArgs,
      allocationFactoryExtraArgs: params.context.allocationFactoryExtraArgs,
      disclosure: params.context.allocationFactoryDisclosure,
      settlement: {
        executors: [params.context.operator],
        id: `DexOrder-${settlementRef}`,
        cid: null,
        meta: { values: {} },
      },
      allocationSpec: {
        admin: params.context.admin,
        authorizer: { owner: trader, provider: null, id: '' },
        transferLegSides: [],
        settlementDeadline: params.expiry,
        nextIterationFunding: { [lockInstrumentId]: lockAmount },
        committed: true,
        meta: { values: {} },
      },
      inputHoldingCids: inputHoldingCids as ContractId<'Holding'>[],
      hint: { instrumentId: lockInstrumentId, amount: lockAmount },
    });
    const allocationCid = walletRes.createdAllocationCids?.[0];
    if (!allocationCid) {
      throw new Error('order funding: wallet did not return the created allocation cid');
    }

    const fundRes = await operator.fundOrder({
      orderCid: bindRes.orderCid as ContractId<'Order'>,
      allocationCid: allocationCid as ContractId<'Allocation'>,
    });
    return { orderId: fundRes.orderCid };
  },

  // Operator-authority write -- straight HTTP, no wallet involvement.
  cancelOrder: (orderId: string) =>
    fetchJson<void>(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
    }),

  // DvP add, two calls around one wallet submission:
  //   1. operator creates the LiquidityAllocationRequest (/request);
  //   2. the trader's wallet authors the 3 allocations the request names;
  //   3. operator + lpRegistrar settle with the created cids (/settle).
  // For the self-registry admin == lpRegistrar, so one factory backs both
  // the deposit (pool.admin) and LP-receipt (pool.lpRegistrar) legs.
  addLiquidity: async (params: {
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
      depositFactoryExtraArgs: req.depositFactoryExtraArgs,
      lpFactoryExtraArgs: req.lpFactoryExtraArgs,
      disclosure: [...req.depositFactoryDisclosure, ...req.lpFactoryDisclosure],
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

  // DvP remove, symmetric to add: the operator derives the slice
  // draw + creates the request; the trader's wallet authors the base/quote
  // receipts + the LP burn-sender; the operator + lpRegistrar settle,
  // delivering base+quote to the holder and burning the LP tokens. The
  // wallet normalizes fragmented LP holdings to an exact burn amount first,
  // so partial removals do not over-lock the trader's LP position.
  removeLiquidity: async (params: {
    poolId: string;
    holder: string;
    lpAdmin: string;
    lpInstrumentId: string;
    lpTokens: number;
    minBaseOut: number;
    minQuoteOut: number;
  }) => {
    const lpTokensToRedeem = formatDecimal10(params.lpTokens);
    const holderLpHoldingCids = await normalizeSwapFunding({
      admin: params.lpAdmin,
      party: params.holder,
      instrumentId: params.lpInstrumentId,
      amount: lpTokensToRedeem,
    });
    if (!holderLpHoldingCids || holderLpHoldingCids.length === 0) {
      throw new Error(
        `remove-liquidity: no exact unlocked ${params.lpInstrumentId} holdings cover ${lpTokensToRedeem}`,
      );
    }
    const requestedAt = new Date().toISOString();
    const req = await fetchJson<RequestRemoveResult>('/v1/pools/remove-liquidity/request', {
      method: 'POST',
      body: JSON.stringify({
        poolCid: params.poolId,
        holder: params.holder,
        lpTokensToRedeem,
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
      depositFactoryExtraArgs: req.depositFactoryExtraArgs,
      lpFactoryExtraArgs: req.lpFactoryExtraArgs,
      disclosure: [...req.depositFactoryDisclosure, ...req.lpFactoryDisclosure],
      lpHoldingCids: holderLpHoldingCids,
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
        lpTokensToRedeem,
        knownTotalLpSupply: req.knownTotalLpSupply,
        minBaseOut: formatDecimal10(params.minBaseOut),
        minQuoteOut: formatDecimal10(params.minQuoteOut),
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
