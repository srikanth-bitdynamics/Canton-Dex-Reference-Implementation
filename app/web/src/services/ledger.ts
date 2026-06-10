// Single client surface the React pages import from. Delegates to:
//   - OperatorApi (HTTP) for orchestration calls + read queries the
//     operator can answer
//   - Wallet handoff for trader-authority writes (place order, add
//     liquidity, swap allocation creation) -- the dApp NEVER signs as
//     the trader.
//
// This file is the boundary the rest of the dApp imports from. Adding
// a new method here is an explicit, auditable extension; the React
// components below this layer should never reach past it.

import { OperatorApi } from './operator-api';
import { handToWallet } from '@/wallet/handoff';
import { getProvider } from '@/wallet/registry';
import { coSignsAdmin } from '@/wallet/capabilities';
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

// Empty Token Standard V2 choice context (our own DAR's AllocationRequest
// needs no external registry context to accept).
const EMPTY_EXTRA_ARGS: V2ExtraArgs = { context: { values: {} }, meta: { values: {} } };

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

async function getWalletNativeHoldings(owner: string): Promise<Holding[] | null> {
  const walletState = useWalletStore.getState();
  const providerId = walletState.activeProviderId;
  if (!providerId || walletState.account?.party !== owner) return null;

  try {
    const provider = getProvider(providerId);
    if (!provider.listHoldings) return null;
    return await provider.listHoldings(owner);
  } catch (err) {
    console.warn('[wallet] falling back to operator holdings read', err);
    return null;
  }
}

/**
 * Render a number as a plain decimal string, never scientific notation.
 * `Number.prototype.toString()` emits `1e+21` for large magnitudes and
 * `1e-7` for small ones; both are rejected by Canton's Numeric wire format
 * and by our `decimal10StringUnits` parser. This expands the
 * exponent into a fixed-point string instead.
 */
export function formatDecimal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`formatDecimal: non-finite amount ${value}`);
  }
  const str = String(value);
  if (!/e/i.test(str)) return str;

  // Expand scientific notation manually.
  const [mantissa, expRaw] = str.split(/e/i);
  const exp = Number(expRaw);
  const sign = mantissa.startsWith('-') ? '-' : '';
  const digits = mantissa.replace('-', '');
  const [intPart, fracPart = ''] = digits.split('.');
  const allDigits = intPart + fracPart;
  // Position of the decimal point measured from the left of `allDigits`.
  const pointPos = intPart.length + exp;

  let out: string;
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${allDigits}`;
  } else if (pointPos >= allDigits.length) {
    out = `${allDigits}${'0'.repeat(pointPos - allDigits.length)}`;
  } else {
    out = `${allDigits.slice(0, pointPos)}.${allDigits.slice(pointPos)}`;
  }
  // Trim a trailing bare dot, if any.
  return `${sign}${out}`.replace(/\.$/, '');
}

export function formatDecimal10(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`formatDecimal10: non-finite amount ${value}`);
  }
  // toFixed(10) is safe for the magnitudes the UI handles, but it also emits
  // scientific notation above ~1e21. Round-trip through the non-scientific
  // formatter + the string→units parser so callers always get a plain
  // 10-dp decimal string.
  if (Math.abs(value) < 1e21) return value.toFixed(10);
  return unitsToDecimal10(decimal10StringUnits(formatDecimal(value)));
}

function multiplyDecimal10(left: number | string, right: number | string): string {
  const scaled = toUnits(left) * toUnits(right);
  return unitsToDecimal10(scaled / 10_000_000_000n);
}

/** Coerce a number-or-string amount to scaled 10-dp integer units. */
function toUnits(value: number | string): bigint {
  return typeof value === 'string'
    ? decimal10StringUnits(value)
    : decimal10StringUnits(formatDecimal10(value));
}

function decimal10Units(value: number): bigint {
  // Route through the string parser so values ≥1e21 (where toFixed/String
  // emit scientific notation) no longer throw in BigInt().
  return decimal10StringUnits(formatDecimal10(value));
}

/**
 * Scaled 10-dp integer units for a holding, preferring the exact wire string
 * (`amountRaw`) over the float `amount` so funding-cid selection keeps full
 * precision at the service boundary.
 */
function holdingUnits(h: Holding): bigint {
  return h.amountRaw != null
    ? decimal10StringUnits(h.amountRaw)
    : decimal10Units(h.amount);
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
      units: holdingUnits(h),
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
      units: holdingUnits(h),
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

/**
 * Whether the active wallet can co-sign as the instrument admin. The registry's
 * Holding_Split/Holding_Merge are `controller admin, owner`, so split/merge
 * normalization is only authorized through providers that route an admin
 * co-sign (operator relay / dev). Real external wallets cannot, so for them we
 * must not compose split/merge and instead fall back to exact-subset selection.
 */
function activeWalletCoSignsAdmin(): boolean {
  const providerId = useWalletStore.getState().activeProviderId;
  if (!providerId) return false;
  return coSignsAdmin(providerId);
}

/**
 * Resolve the cid of the holding produced by a merge, given the running set of
 * already-consumed cids and the accumulated units. Providers like PartyLayer
 * return only an `updateId` (no `createdHoldingCids`), so we re-query the ACS
 * and pick the new unlocked holding matching the merged amount. Falls back to
 * the provider-returned cid when present.
 */
async function resolveMergedHoldingCid(params: {
  party: string;
  instrumentId: string;
  admin: string;
  accumulatedUnits: bigint;
  consumedCids: Set<string>;
  providerReturnedCid?: string;
}): Promise<string | null> {
  if (params.providerReturnedCid) return params.providerReturnedCid;
  const holdings = await ledger.getHoldings(params.party);
  // Prefer an exact amount match on a cid we have not seen before.
  const fresh = holdings.filter(
    (h) =>
      h.instrumentId === params.instrumentId &&
      !h.locked &&
      h.admin === params.admin &&
      !params.consumedCids.has(h.contractId),
  );
  const exact = fresh.find((h) => holdingUnits(h) === params.accumulatedUnits);
  if (exact) return exact.contractId;
  // Otherwise the largest fresh holding is the merge result.
  const largest = [...fresh].sort((a, b) =>
    Number(holdingUnits(b) - holdingUnits(a)),
  )[0];
  return largest?.contractId ?? null;
}

// Exported for orchestration tests. Production callers reach it
// through executeSwap/placeOrder/removeLiquidity.
export async function normalizeSwapFunding(params: {
  admin: string;
  party: string;
  instrumentId: string;
  amount: number | string;
}): Promise<string[] | null> {
  let holdings = await ledger.getHoldings(params.party);

  // First, always try an exact unlocked subset — this never needs admin
  // authority and works on every provider.
  const exactCids = pickExactHoldingCids(
    holdings,
    params.instrumentId,
    params.amount,
    params.admin,
  );
  if (exactCids) return exactCids;

  // No exact subset. Split/merge normalization needs an admin co-sign. If the
  // active wallet can't provide it (real external wallet), do NOT compose
  // split/merge (it would fail on the live path); return null so the caller
  // surfaces a clear "split holdings first" error.
  if (!activeWalletCoSignsAdmin()) return null;

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

  // merge-then-split: chain merges, resolving the freshly-created holding cid
  // after each step (the provider may only return an updateId).
  const consumedCids = new Set<string>([
    plan.primaryHoldingCid,
    ...plan.otherHoldingCids,
  ]);
  let currentCid = plan.primaryHoldingCid;
  let accumulatedUnits = holdingUnitsForCid(holdings, currentCid);
  for (const otherCid of plan.otherHoldingCids) {
    accumulatedUnits += holdingUnitsForCid(holdings, otherCid);
    const result = await handToWallet({
      kind: 'merge-holdings',
      holdingCid: currentCid,
      otherCid,
      admin: params.admin,
    });
    const resolved = await resolveMergedHoldingCid({
      party: params.party,
      instrumentId: params.instrumentId,
      admin: params.admin,
      accumulatedUnits,
      consumedCids,
      providerReturnedCid: result.createdHoldingCids?.[0],
    });
    if (!resolved) {
      throw new Error(
        'merge-then-split: could not resolve the merged holding cid after a ' +
          'merge step (wallet returned no createdHoldingCids and the merged ' +
          'holding was not found in the ACS).',
      );
    }
    // The merged holding now stands in for both inputs; mark it consumed so a
    // later step never re-selects it as a "fresh" merge output.
    currentCid = resolved;
    consumedCids.add(resolved);
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

/** Units for a specific cid in a holdings list (0 if not found). */
function holdingUnitsForCid(holdings: Holding[], cid: string): bigint {
  const h = holdings.find((x) => x.contractId === cid);
  return h ? holdingUnits(h) : 0n;
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
    const walletHoldings = await getWalletNativeHoldings(owner);
    if (walletHoldings) return walletHoldings;

    const raw = await fetchJson<Holding[]>(
      `/v1/holdings?owner=${encodeURIComponent(owner)}`,
    );
    const num = (v: unknown): number =>
      typeof v === 'number' ? v : parseFloat(String(v ?? 0));
    // Preserve the exact wire string in `amountRaw` so funding-cid selection
    // keeps full precision; `amount` stays a float for display/math.
    return raw.map((h) => ({
      ...h,
      amount: num(h.amount),
      amountRaw: typeof h.amount === 'string' ? h.amount : h.amountRaw,
    }));
  },

  computeSwapQuote: async (
    poolId: string,
    inputInstrumentId: string,
    inputAmount: number,
  ) => {
    const out = await operator.computeSwapQuote({
      poolId,
      inputInstrumentId,
      inputAmount: formatDecimal(inputAmount),
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
    // updateId-only wallets (e.g. PartyLayer) return no created cid; the operator
    // recovers the swap input allocation from the tree by updateId.
    const updateId = walletResult.auxiliaryCids?.updateId;
    if (!swapperAllocationCid && !updateId) {
      throw new Error(
        'swap: wallet returned neither a created allocation cid nor an updateId',
      );
    }

    // 3. Operator settles the swap against the authored allocation (explicit cid
    // or operator-discovery from the updateId).
    return operator.swap({
      poolCid: params.pool.contractId as ContractId<'Pool'>,
      swapperAccount: { owner: params.swapperParty, provider: null, id: '' },
      inputInstrumentId: params.inputInstrumentId,
      inputAmount: formatDecimal10(params.inputAmount),
      minOutputAmount: formatDecimal10(params.minOutputAmount),
      ...(swapperAllocationCid
        ? { swapperAllocationCid: swapperAllocationCid as ContractId<'Allocation'> }
        : { updateId }),
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
    /**
     * Real-step progress callback. Phases map to the `placeOrder` toast
     * lifecycle: 0 Submitted, 1 Bound, 2 Locked, 3 Open.
     */
    onProgress?: (phase: number) => void;
  }) => {
    const progress = params.onProgress ?? (() => {});
    const trader = connectedParty();
    const result = await handToWallet({
      kind: 'place-order',
      pair: { base: params.pairBase, quote: params.pairQuote },
      side: params.side,
      limitPrice: formatDecimal(params.limitPrice),
      quantity: formatDecimal(params.quantity),
      expiry: params.expiry,
      operator: params.context.operator,
      admin: params.context.admin,
    });
    progress(0); // Submitted to operator.
    const settlementRef = `web-${Date.now()}`;
    const bindRes = await operator.bindOrder({
      fundingRequestCid: result.primaryCid as ContractId<'OrderFundingRequest'>,
      settlementRef,
    });
    progress(1); // Bound: order + allocation request now exist on-ledger.

    // Everything past bind operates on a live on-ledger Order. If any of it
    // throws, the order is bound-but-unfunded ("stuck"): surface a warning that
    // names the order cid and best-effort cancel it.
    const orderCid = bindRes.orderCid as ContractId<'Order'>;
    try {
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
      progress(2); // Funding allocation locked.
      const allocationCid = walletRes.createdAllocationCids?.[0];
      // updateId-only wallets (e.g. PartyLayer): the operator recovers the
      // order's funding allocation from the tree by updateId.
      const updateId = walletRes.auxiliaryCids?.updateId;
      if (!allocationCid && !updateId) {
        throw new Error(
          'order funding: wallet returned neither a created allocation cid nor an updateId',
        );
      }

      const fundRes = await operator.fundOrder({
        orderCid,
        ...(allocationCid
          ? { allocationCid: allocationCid as ContractId<'Allocation'> }
          : { updateId }),
      });
      progress(3); // In book — awaiting match.
      return { orderId: fundRes.orderCid };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Best-effort cancel of the stranded order so the trader isn't left with
      // a bound-but-unfunded order silently sitting on-ledger.
      let cancelNote = '';
      try {
        await ledger.cancelOrder(orderCid);
        cancelNote = ' The bound order was cancelled.';
      } catch (cancelErr) {
        const cancelMsg =
          cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
        cancelNote =
          ` Automatic cancel also failed (${cancelMsg}); cancel order ${orderCid} manually.`;
      }
      throw new Error(
        `Order ${orderCid} is stuck: bound on-ledger but funding did not complete (${reason}).${cancelNote}`,
      );
    }
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
        baseAmount: formatDecimal(params.baseAmount),
        quoteAmount: formatDecimal(params.quoteAmount),
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
      // The request lives in our own DAR; accept needs no registry context.
      allocationRequestExtraArgs: EMPTY_EXTRA_ARGS,
      disclosure: [...req.depositFactoryDisclosure, ...req.lpFactoryDisclosure],
      baseHoldingCids: params.baseHoldingCids ?? [],
      quoteHoldingCids: params.quoteHoldingCids ?? [],
    });
    const cids = walletRes.createdAllocationCids;
    // updateId-only wallets (e.g. PartyLayer) return no created cids; the
    // operator recovers them from the tree by updateId (operator-discovery).
    const updateId = walletRes.auxiliaryCids?.updateId;
    if ((!cids || cids.length !== 3) && !updateId) {
      throw new Error(
        'wallet returned neither the 3 created allocation cids nor an updateId for add-liquidity',
      );
    }
    // Canonical accept flow consumes the request and leaves acceptance
    // evidence; bind settle to that. Fall back to the live request only if no
    // acceptance surfaced (legacy direct-allocation path).
    const liquidityAcceptanceCid = walletRes.auxiliaryCids?.liquidityAcceptanceCid;
    const settleBody =
      cids && cids.length === 3
        ? {
            poolCid: params.poolId,
            requestCid: liquidityAcceptanceCid ? undefined : req.requestCid,
            acceptanceCid: liquidityAcceptanceCid,
            recipient,
            lpBaseDepositCid: cids[0],
            lpQuoteDepositCid: cids[1],
            lpReceiptCid: cids[2],
            baseAmount: req.baseAmount,
            quoteAmount: req.quoteAmount,
            minLpTokens: formatDecimal(params.minLpTokens),
            knownTotalLpSupply: req.knownTotalLpSupply,
            requestedAt,
          }
        : {
            // operator-discovery path: hand over the updateId only.
            poolCid: params.poolId,
            updateId,
            recipient,
            baseAmount: req.baseAmount,
            quoteAmount: req.quoteAmount,
            minLpTokens: formatDecimal(params.minLpTokens),
            knownTotalLpSupply: req.knownTotalLpSupply,
            requestedAt,
          };
    await fetchJson('/v1/pools/add-liquidity/settle', {
      method: 'POST',
      body: JSON.stringify(settleBody),
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
      allocationRequestExtraArgs: EMPTY_EXTRA_ARGS,
      disclosure: [...req.depositFactoryDisclosure, ...req.lpFactoryDisclosure],
      lpHoldingCids: holderLpHoldingCids,
    });
    const cids = walletRes.createdAllocationCids;
    const updateId = walletRes.auxiliaryCids?.updateId;
    if ((!cids || cids.length !== 3) && !updateId) {
      throw new Error(
        'wallet returned neither the 3 created allocation cids nor an updateId for remove-liquidity',
      );
    }
    const liquidityAcceptanceCid = walletRes.auxiliaryCids?.liquidityAcceptanceCid;
    const common = {
      poolCid: params.poolId,
      holder: params.holder,
      lpTokensToRedeem,
      knownTotalLpSupply: req.knownTotalLpSupply,
      minBaseOut: formatDecimal10(params.minBaseOut),
      minQuoteOut: formatDecimal10(params.minQuoteOut),
      requestedAt,
    };
    const settleBody =
      cids && cids.length === 3
        ? {
            ...common,
            requestCid: liquidityAcceptanceCid ? undefined : req.requestCid,
            acceptanceCid: liquidityAcceptanceCid,
            holderBaseReceiptCid: cids[0],
            holderQuoteReceiptCid: cids[1],
            holderBurnSenderCid: cids[2],
          }
        : { ...common, updateId }; // operator-discovery path
    return fetchJson<{ result: unknown }>('/v1/pools/remove-liquidity/settle', {
      method: 'POST',
      body: JSON.stringify(settleBody),
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
