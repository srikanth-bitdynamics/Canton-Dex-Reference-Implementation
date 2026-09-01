// Single client surface the React pages import from. Delegates to:
//   - OperatorApi (HTTP) for orchestration calls + read queries the
//     operator can answer
//   - Wallet handoff for trader-authority writes (place order, add liquidity,
//     and swap allocation creation). The dApp does not sign as the trader.
//
// This file is the boundary the rest of the dApp imports from. Adding
// a new method here is an explicit, auditable extension; the React
// components below this layer should never reach past it.

import { OperatorApi, type SwapQuoteBinding } from './operator-api';
import { apiAuthHeaders } from './api-auth';
import { handToWallet } from '@/wallet/handoff';
import { specFundsHoldings } from '@/wallet/commands';
import { getProvider } from '@/wallet/registry';
import { coSignsAdmin } from '@/wallet/capabilities';
import { useWalletStore } from '@/wallet/store';
import type {
  ContractId,
  V2AllocationSpecification,
  V2ExtraArgs,
  V2SettlementInfo,
} from '@/wallet/types';
import type {
  Order,
  Holding,
  DexPair,
  InstrumentId,
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
}

function connectedParty(): string {
  const party = useWalletStore.getState().account?.party;
  if (!party) throw new Error('connect a wallet before performing this action');
  return party;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';

const operator = new OperatorApi(API_BASE);

async function discoverAllocationFactory(params: {
  admin: string;
  settlement: V2SettlementInfo;
  allocation: V2AllocationSpecification;
  requestedAt: string;
  inputHoldingCids: string[];
  actors: string[];
}) {
  return operator.getAllocationFactory({
    admin: params.admin,
    choiceArguments: {
      settlement: params.settlement,
      allocation: params.allocation,
      requestedAt: params.requestedAt,
      inputHoldingCids: params.inputHoldingCids,
      actors: params.actors,
      extraArgs: EMPTY_EXTRA_ARGS,
    },
  });
}

async function getWalletNativeHoldings(owner: string): Promise<Holding[] | null> {
  const walletState = useWalletStore.getState();
  const providerId = walletState.activeProviderId;
  if (!providerId || walletState.account?.party !== owner) return null;

  const provider = getProvider(providerId);
  if (!provider.listHoldings) return null;
  try {
    return await provider.listHoldings(owner);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`wallet holdings read failed (${providerId}): ${msg}`);
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

/** Full-identity equality: both registry admin and text id must match. */
function instrumentIdEq(a: InstrumentId, b: InstrumentId): boolean {
  return a.admin === b.admin && a.id === b.id;
}

// Validate the swapper allocation specs the operator returned before the wallet
// signs. One spec for a single-admin swap (swap-in + swap-out on one
// allocation), two for a cross-admin swap: the swap-in leg under the input
// admin, the swap-out receipts under the output admin. The input is a full
// `{admin, id}`; side is decided by full-identity equality so USD@A and USD@B
// never collide.
export function assertSwapAuthority(params: {
  context: DexContext;
  pool: {
    contractId: string;
    baseInstrumentId: InstrumentId;
    quoteInstrumentId: InstrumentId;
  };
  swapper: string;
  inputInstrumentId: InstrumentId;
  inputAmount: string;
  minOutputAmount: string;
  allocationSpecs: V2AllocationSpecification[];
  settlement: V2SettlementInfo;
  quoteBinding: SwapQuoteBinding;
}): void {
  const { allocationSpecs: specs, settlement, quoteBinding } = params;
  const inputIsBase = instrumentIdEq(params.inputInstrumentId, params.pool.baseInstrumentId);
  const inputIsQuote = instrumentIdEq(params.inputInstrumentId, params.pool.quoteInstrumentId);
  // Transfer legs name the instrument by text id only; the admin lives on the
  // allocation spec. Leg-side comparisons therefore use the bare id.
  const inputId = params.inputInstrumentId.id;
  const outputInstrumentId = inputIsBase
    ? params.pool.quoteInstrumentId.id
    : params.pool.baseInstrumentId.id;
  const inputAdmin = inputIsBase
    ? params.pool.baseInstrumentId.admin
    : params.pool.quoteInstrumentId.admin;
  const outputAdmin = inputIsBase
    ? params.pool.quoteInstrumentId.admin
    : params.pool.baseInstrumentId.admin;
  const poolAccount = (account: { owner: string | null; provider: string | null; id: string }) =>
    account.owner === params.context.operator && account.provider === null && account.id === '';

  if (!inputIsBase && !inputIsQuote) {
    throw new Error('swap: operator returned an invalid trader allocation authority');
  }
  if (
    settlement.executors.length !== 1 ||
    settlement.executors[0] !== params.context.operator ||
    settlement.id !== 'DexPool' ||
    settlement.cid !== params.pool.contractId
  ) {
    throw new Error('swap: operator returned an invalid settlement descriptor');
  }
  if (
    quoteBinding.minOutputAmount !== params.minOutputAmount ||
    quoteBinding.outputSliceCids.length === 0
  ) {
    throw new Error('swap: operator returned a quote binding that differs from the request');
  }

  // Exactly one spec per expected admin, each a one-shot allocation authorized
  // by the swapper (uncommitted, no next-iteration funding).
  const expectedAdmins = inputAdmin === outputAdmin ? [inputAdmin] : [inputAdmin, outputAdmin];
  if (specs.length !== expectedAdmins.length) {
    throw new Error('swap: operator returned an invalid trader allocation authority');
  }
  for (const spec of specs) {
    if (
      !expectedAdmins.includes(spec.admin) ||
      specs.filter((s) => s.admin === spec.admin).length !== 1 ||
      spec.authorizer.owner !== params.swapper ||
      spec.authorizer.provider !== null ||
      spec.authorizer.id !== '' ||
      spec.nextIterationFunding !== null ||
      spec.committed
    ) {
      throw new Error('swap: operator returned an invalid trader allocation authority');
    }
  }
  const inputSpec = specs.find((s) => s.admin === inputAdmin)!;
  const outputSpec = specs.find((s) => s.admin === outputAdmin)!;

  // Input spec: exactly the swap-in sender leg.
  const senderSides = inputSpec.transferLegSides.filter((side) => side.side === 'SenderSide');
  const sender = senderSides[0];
  if (
    senderSides.length !== 1 ||
    !sender ||
    sender.transferLegId !== 'swap-in' ||
    sender.instrumentId !== inputId ||
    decimal10StringUnits(sender.amount) !== decimal10StringUnits(params.inputAmount) ||
    !poolAccount(sender.otherside)
  ) {
    throw new Error('swap: operator returned allocation input that differs from the request');
  }

  // Output spec: the swap-out receiver legs.
  const receiverSides = outputSpec.transferLegSides.filter((side) => side.side === 'ReceiverSide');
  if (
    receiverSides.length === 0 ||
    receiverSides.some((side, index) =>
      side.transferLegId !== `swap-out-${index}` ||
      side.instrumentId !== outputInstrumentId ||
      decimal10StringUnits(side.amount) <= 0n ||
      !poolAccount(side.otherside)
    )
  ) {
    throw new Error('swap: operator returned invalid allocation output legs');
  }

  // No stray leg sides: the input spec holds only the sender, the output spec
  // only the receivers. A single-admin swap has both on one spec.
  if (inputAdmin === outputAdmin) {
    if (senderSides.length + receiverSides.length !== inputSpec.transferLegSides.length) {
      throw new Error('swap: operator returned unsupported allocation leg sides');
    }
  } else if (
    inputSpec.transferLegSides.length !== senderSides.length ||
    outputSpec.transferLegSides.length !== receiverSides.length
  ) {
    throw new Error('swap: operator returned unsupported allocation leg sides');
  }

  const outputAmount = receiverSides.reduce(
    (sum, side) => sum + decimal10StringUnits(side.amount),
    0n,
  );
  if (outputAmount < decimal10StringUnits(params.minOutputAmount)) {
    throw new Error('swap: signed output is below the requested slippage minimum');
  }
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
 * Pick a minimal set of unlocked holdings whose summed units COVER the target
 * (sum >= target), or null if the total is insufficient.
 *
 * Unlike `pickExactHoldingCids`, this accepts a covering set. The reference
 * registry locks only the requested notional and returns unused inputs and
 * split change through `authorizerChangeCids`, so the wallet does not need a
 * separate admin-co-signed `Holding_Split` first.
 *
 * Prefers the single smallest holding that already covers the target (one
 * piece, least surplus); otherwise accumulates largest-first for the fewest
 * pieces.
 */
export function pickCoveringHoldingCids(
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
  const candidates = unlockedInstrumentHoldings(holdings, instrumentId, admin);

  // A single holding that covers the target on its own — pick the smallest
  // such, to minimise the surplus locked (and returned) and keep it to one
  // piece.
  const singleCover = candidates
    .filter((h) => h.units >= target)
    .sort((a, b) => Number(a.units - b.units))[0];
  if (singleCover) return [singleCover.contractId];

  // No single holding covers — accumulate largest-first until covered.
  const descending = [...candidates].sort((a, b) => Number(b.units - a.units));
  const chosen: string[] = [];
  let accumulated = 0n;
  for (const holding of descending) {
    chosen.push(holding.contractId);
    accumulated += holding.units;
    if (accumulated >= target) return chosen;
  }
  return null; // total across all unlocked holdings is below the target
}

/**
 * Whether the active wallet can co-sign as the instrument admin. The registry's
 * Holding_Split/Holding_Merge are `controller admin, owner`, so split/merge
 * normalization is only authorized through providers that route an admin
 * co-sign (operator relay / dev). Other wallets use a covering holding set and
 * let `AllocationFactory_Allocate` return the excess as change.
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

  // Split/merge needs an admin co-sign. Without one, pass a covering set to the
  // allocation factory; it locks the requested notional and returns change.
  if (!activeWalletCoSignsAdmin()) {
    return pickCoveringHoldingCids(
      holdings,
      params.instrumentId,
      params.amount,
      params.admin,
    );
  }

  const plan = planSwapFunding(
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
  network: string;
}

export interface DexStatus {
  network: string;
  slot: number;
  synced: boolean;
  serverTime: string;
}

// Best-effort: match a trade's two instrument identities to a listed DexPair so
// its fees accrue on settle. The specs carry each side's admin and instrument
// id, so the trade's full instrument set is reconstructed here. Returns
// undefined (Daml `None` = no accrual) when no listed pair covers the set or the
// lookup fails, so fee recording never blocks settlement.
async function resolveTradeDexPairCid(
  requests: Array<{ allocations: unknown }>,
): Promise<ContractId<'DexPair'> | undefined> {
  const identities = new Map<string, InstrumentId>();
  for (const r of requests) {
    for (const spec of r.allocations as V2AllocationSpecification[]) {
      for (const side of spec.transferLegSides) {
        identities.set(`${spec.admin} ${side.instrumentId}`, {
          admin: spec.admin,
          id: side.instrumentId,
        });
      }
    }
  }
  const wanted = [...identities.values()];
  if (wanted.length !== 2) return undefined;
  let pairs: DexPair[];
  try {
    pairs = await fetchJson<DexPair[]>('/v1/pairs');
  } catch {
    return undefined;
  }
  if (!Array.isArray(pairs)) return undefined;
  const lists = (p: DexPair, iid: InstrumentId): boolean =>
    (p.baseInstrumentId.admin === iid.admin && p.baseInstrumentId.id === iid.id) ||
    (p.quoteInstrumentId.admin === iid.admin && p.quoteInstrumentId.id === iid.id);
  const match = pairs.find((p) => wanted.every((iid) => lists(p, iid)));
  return match ? (match.contractId as ContractId<'DexPair'>) : undefined;
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
    inputInstrumentId: InstrumentId,
    inputAmount: number,
  ) => {
    const out = await operator.computeSwapQuote({
      poolId,
      inputInstrumentId,
      inputAmount: formatDecimal10(inputAmount),
    });
    return { outputAmount: parseFloat(out.outputAmount) };
  },

  // === write endpoints =====================================================
  //
  // Swap/order writes still take a `context` argument carrying the venue
  // operator and default factory surface. Swap and DvP liquidity use the
  // selected pool's registry admin and fetch their factories from `/request`.

  /**
   * Trader-authority swap. Resolves the output instrument from the pool
   * (caller passes it because the page already has the Pool object).
   */
  executeSwap: async (params: {
    context: DexContext;
    pool: {
      contractId: string;
      baseInstrumentId: InstrumentId;
      quoteInstrumentId: InstrumentId;
    };
    // Full instrument identity from the pool's base/quote; side is decided by
    // full-identity equality, not the bare symbol.
    inputInstrumentId: InstrumentId;
    inputAmount: number;
    minOutputAmount: number;
    swapperParty: string;
    inputHoldingCids?: string[];
  }) => {
    const inputIsBase = instrumentIdEq(params.inputInstrumentId, params.pool.baseInstrumentId);
    const inputAdmin = inputIsBase
      ? params.pool.baseInstrumentId.admin
      : params.pool.quoteInstrumentId.admin;
    const inputId = params.inputInstrumentId.id;
    // Three-call DvP swap: (1) Daml builds the per-admin allocation specs +
    // request for one pool snapshot; (2) the wallet accepts the request and
    // authors every spec, locking only the input, returning the created
    // Allocation cids (input admin first); (3) the operator settles via
    // PoolRules_Swap with those cids. The promise resolves on the real settle
    // result — no optimistic success.
    let inputHoldingCids = params.inputHoldingCids;
    if (!inputHoldingCids || inputHoldingCids.length === 0) {
      inputHoldingCids = await normalizeSwapFunding({
        admin: inputAdmin,
        party: params.swapperParty,
        instrumentId: inputId,
        amount: params.inputAmount,
      }) ?? undefined;
    }
    if (!inputHoldingCids || inputHoldingCids.length === 0) {
      throw new Error(
        `swap: insufficient unlocked ${inputId} balance to fund ${formatDecimal10(params.inputAmount)}`,
      );
    }

    // 1. Operator-built per-admin allocation specs + request + settlement.
    const req = await operator.requestSwap({
      poolCid: params.pool.contractId as ContractId<'Pool'>,
      swapper: params.swapperParty,
      inputInstrumentId: params.inputInstrumentId,
      inputAmount: formatDecimal10(params.inputAmount),
      minOutputAmount: formatDecimal10(params.minOutputAmount),
    });
    const specs = req.allocationSpecs as V2AllocationSpecification[];

    assertSwapAuthority({
      context: params.context,
      pool: params.pool,
      swapper: params.swapperParty,
      inputInstrumentId: params.inputInstrumentId,
      inputAmount: formatDecimal10(params.inputAmount),
      minOutputAmount: formatDecimal10(params.minOutputAmount),
      allocationSpecs: specs,
      settlement: req.settlement as V2SettlementInfo,
      quoteBinding: req.quoteBinding,
    });

    const requestedAt = new Date().toISOString();
    // Discover a factory per admin; only the swap-in spec draws input holdings.
    const factories = await Promise.all(
      specs.map((allocation) =>
        discoverAllocationFactory({
          admin: allocation.admin,
          settlement: req.settlement as V2SettlementInfo,
          allocation,
          requestedAt,
          inputHoldingCids: specFundsHoldings(allocation) ? inputHoldingCids! : [],
          actors: [params.swapperParty],
        }),
      ),
    );

    // 2. Wallet accepts the request and authors every spec in one command.
    const walletResult = await handToWallet({
      kind: 'request-swap',
      poolId: params.pool.contractId,
      requestCid: req.swapRequestCid,
      settlement: req.settlement as V2SettlementInfo,
      allocations: specs,
      requestedAt,
      factoryCids: factories.map((f) => f.factoryCid),
      allocationFactoryExtraArgs: factories.map((f) => f.extraArgs),
      allocationRequestExtraArgs: EMPTY_EXTRA_ARGS,
      disclosure: factories.flatMap((f) => f.disclosure),
      inputHoldingCids: inputHoldingCids as ContractId<'Holding'>[],
    });
    const swapperAllocationCids = walletResult.createdAllocationCids;
    // updateId-only wallets (e.g. PartyLayer) return no created cids; the operator
    // recovers the signed swap allocations from the tree by updateId (one per admin).
    const updateId = walletResult.auxiliaryCids?.updateId;
    const haveCids =
      swapperAllocationCids != null && swapperAllocationCids.length === specs.length;
    if (!haveCids && !updateId) {
      throw new Error(
        'swap: wallet returned neither the created allocation cids nor an updateId',
      );
    }

    // 3. Operator settles the swap against the authored allocations (explicit
    // cids in admin order, or operator-discovery from the updateId).
    return operator.swap({
      poolCid: params.pool.contractId as ContractId<'Pool'>,
      swapperAccount: { owner: params.swapperParty, provider: null, id: '' },
      inputInstrumentId: params.inputInstrumentId,
      inputAmount: formatDecimal10(params.inputAmount),
      minOutputAmount: formatDecimal10(params.minOutputAmount),
      quoteBinding: req.quoteBinding,
      ...(haveCids
        ? { swapperAllocationCids: swapperAllocationCids as ContractId<'Allocation'>[] }
        : { updateId }),
    });
  },

  /**
   * Drive an accepted RFQ's MatchedTrade to settlement. The operator requests
   * one TradeAllocationRequest per non-venue authorizer — the connected party
   * and, in a real two-party RFQ, the counterparty (a distinct party/session).
   * This session holds only the connected party's authority, so it funds that
   * party's request and authors its per-admin allocations via BatchingUtilityV2.
   *
   * The connected session cannot author the counterparty's allocations, and the
   * operator settle binds only caller-supplied cids, so when a separate
   * counterparty request exists this funds this side and stops short of settling
   * — settling with one side's cids would omit the other admin's coverage. The
   * counterparty funds its own request from its own session. When the connected
   * party is the sole non-venue funder (single request; the single-admin demo
   * case), its cids cover the trade and settlement completes here.
   */
  settleMatchedTrade: async (params: { tradeCid: string; trader: string }) => {
    const tradeCid = params.tradeCid as ContractId<'MatchedTrade'>;
    const { allocationRequests } = await operator.requestMatchedTradeAllocations({
      tradeCid,
    });

    // Fees accrue against the trade's pair when one is listed; None otherwise.
    const dexPairCid = await resolveTradeDexPairCid(allocationRequests);

    // Split into this session's own request and the counterparty's. Only the
    // connected party's specs name it as authorizer, so it funds exactly one.
    const ownsRequest = (r: { allocations: unknown }) =>
      (r.allocations as V2AllocationSpecification[]).some(
        (a) => a.authorizer.owner === params.trader,
      );
    const traderRequest = allocationRequests.find(ownsRequest);
    const counterpartyRequests = allocationRequests.filter((r) => !ownsRequest(r));
    if (!traderRequest) {
      // Nothing for this party to fund; let the operator settle what it has.
      return operator.settleMatchedTrade({
        tradeCid,
        allocationRequestCids: [],
        ...(dexPairCid ? { dexPairCid } : {}),
      });
    }

    const specs = traderRequest.allocations as V2AllocationSpecification[];
    const settlement = traderRequest.settlement as V2SettlementInfo;
    const requestedAt = traderRequest.requestedAt;

    // Select input holdings for the single sender-leg (funding) spec. A trader
    // sends exactly one asset in a trade, so at most one spec funds holdings;
    // the counter-admin spec, if any, only receives.
    const fundingSpecs = specs.filter(specFundsHoldings);
    if (fundingSpecs.length > 1) {
      throw new Error(
        'matched-trade settle: expected a single funding spec for the connected party',
      );
    }
    let inputHoldingCids: string[] = [];
    const fundingSpec = fundingSpecs[0];
    if (fundingSpec) {
      const senderLeg = fundingSpec.transferLegSides.find((s) => s.side === 'SenderSide');
      if (!senderLeg) {
        throw new Error('matched-trade settle: funding spec has no sender leg');
      }
      const cids = await normalizeSwapFunding({
        admin: fundingSpec.admin,
        party: params.trader,
        instrumentId: senderLeg.instrumentId,
        amount: senderLeg.amount,
      });
      if (!cids || cids.length === 0) {
        throw new Error(
          `matched-trade settle: insufficient unlocked ${senderLeg.instrumentId} balance to fund ${senderLeg.amount}`,
        );
      }
      inputHoldingCids = cids;
    }

    // Discover a factory per spec; only the funding spec draws holdings.
    const factories = await Promise.all(
      specs.map((allocation) =>
        discoverAllocationFactory({
          admin: allocation.admin,
          settlement,
          allocation,
          requestedAt,
          inputHoldingCids: specFundsHoldings(allocation) ? inputHoldingCids : [],
          actors: [params.trader],
        }),
      ),
    );

    // Wallet accepts the TradeAllocationRequest and authors every spec at once.
    const walletRes = await handToWallet({
      kind: 'fund-matched-trade',
      requestCid: traderRequest.requestCid as ContractId<'TradeAllocationRequest'>,
      settlement,
      allocations: specs,
      requestedAt,
      factoryCids: factories.map((f) => f.factoryCid),
      allocationFactoryExtraArgs: factories.map((f) => f.extraArgs),
      allocationRequestExtraArgs: EMPTY_EXTRA_ARGS,
      disclosure: factories.flatMap((f) => f.disclosure),
      inputHoldingCids: inputHoldingCids as ContractId<'Holding'>[],
    });

    const createdCids = walletRes.createdAllocationCids;
    // updateId-only wallets (e.g. PartyLayer / SDK) return no created cids; the
    // operator recovers the trader's allocations from the tree by updateId.
    const updateId = walletRes.auxiliaryCids?.updateId;
    const haveCids = createdCids != null && createdCids.length === specs.length;
    if (!haveCids && !updateId) {
      throw new Error(
        'matched-trade settle: wallet returned neither the created allocation cids nor an updateId',
      );
    }

    // Group the created cids by spec admin (specs and cids are parallel).
    let allocationCidsByAdmin: Record<string, ContractId<'Allocation'>[]> | undefined;
    if (haveCids) {
      allocationCidsByAdmin = {};
      specs.forEach((spec, i) => {
        (allocationCidsByAdmin![spec.admin] ??= []).push(
          createdCids![i] as ContractId<'Allocation'>,
        );
      });
    }

    // A separate counterparty request means a genuine two-party RFQ. This
    // session authored only its own side, so settling now would leave the
    // counterparty's admin uncovered. Stop rather than settle partially; the
    // counterparty funds its request from its own session, and settlement
    // completes once both sides are funded and their cids collected.
    if (counterpartyRequests.length > 0) {
      throw new Error(
        'matched-trade settle: the counterparty has not funded its allocation ' +
          'request; both sides must fund before the trade can settle',
      );
    }

    // Operator settles the cross-admin batches. The trader's request was
    // archived by the wallet accept, so no request cid is consumed here.
    return operator.settleMatchedTrade({
      tradeCid,
      ...(haveCids ? { allocationCidsByAdmin } : { updateId }),
      allocationRequestCids: [],
      ...(dexPairCid ? { dexPairCid } : {}),
    });
  },

  placeOrder: async (params: {
    context: DexContext;
    pairBase: InstrumentId;
    pairQuote: InstrumentId;
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
      limitPrice: formatDecimal10(params.limitPrice),
      quantity: formatDecimal10(params.quantity),
      expiry: params.expiry,
      operator: params.context.operator,
    });
    progress(0); // Submitted to operator.
    const settlementRef = `web-${Date.now()}`;
    // updateId-only wallets (CIP-0103 SDK / PartyLayer) return the updateId as
    // primaryCid — NOT a contract id — so the operator recovers the created
    // OrderFundingRequest from the tree by updateId. Full-tree wallets (token-
    // standard) return the real cid and no updateId. Mirror the fundOrder
    // discriminator below.
    const orderUpdateId = result.auxiliaryCids?.updateId;
    const bindRes = await operator.bindOrder({
      settlementRef,
      ...(orderUpdateId
        ? { updateId: orderUpdateId }
        : {
            fundingRequestCid:
              result.primaryCid as ContractId<'OrderFundingRequest'>,
          }),
    });
    progress(1); // Bound: order + allocation request now exist on-ledger.

    // Everything past bind operates on a live on-ledger Order. If any of it
    // throws, the order is bound-but-unfunded ("stuck"): surface a warning that
    // names the order cid and best-effort cancel it.
    const orderCid = bindRes.orderCid as ContractId<'Order'>;
    try {
      const lockInstrument =
        params.side === 'Bid' ? params.pairQuote : params.pairBase;
      const lockAmount =
        params.side === 'Bid'
          ? multiplyDecimal10(params.limitPrice, params.quantity)
          : formatDecimal10(params.quantity);
      const inputHoldingCids = await normalizeSwapFunding({
        admin: lockInstrument.admin,
        party: trader,
        instrumentId: lockInstrument.id,
        amount: lockAmount,
      });
      if (!inputHoldingCids || inputHoldingCids.length === 0) {
        throw new Error(
          `order funding: insufficient unlocked ${lockInstrument.id} balance to cover ${lockAmount}`,
        );
      }

      const requestedAt = new Date().toISOString();
      const specs = bindRes.allocationSpecs as V2AllocationSpecification[];
      // Discover a factory per admin; only the lock-admin funding spec draws
      // input holdings — a cross-admin pair's counter-admin receipt locks nothing.
      const factories = await Promise.all(
        specs.map((allocation) =>
          discoverAllocationFactory({
            admin: allocation.admin,
            settlement: bindRes.settlement as V2SettlementInfo,
            allocation,
            requestedAt,
            inputHoldingCids: specFundsHoldings(allocation) ? inputHoldingCids : [],
            actors: [trader],
          }),
        ),
      );
      const walletRes = await handToWallet({
        kind: 'fund-order',
        requestCid: bindRes.allocationRequestCid as ContractId<'OrderAllocationRequest'>,
        settlement: bindRes.settlement as V2SettlementInfo,
        allocations: specs,
        requestedAt,
        factoryCids: factories.map((f) => f.factoryCid),
        allocationFactoryExtraArgs: factories.map((f) => f.extraArgs),
        allocationRequestExtraArgs: EMPTY_EXTRA_ARGS,
        disclosure: factories.flatMap((f) => f.disclosure),
        inputHoldingCids: inputHoldingCids as ContractId<'Holding'>[],
        hint: { instrumentId: lockInstrument.id, amount: lockAmount },
      });
      progress(2); // Funding allocation(s) locked.
      const allocationCids = walletRes.createdAllocationCids;
      // updateId-only wallets (e.g. PartyLayer): the operator recovers the
      // order's funding allocations from the tree by updateId (one per admin).
      const updateId = walletRes.auxiliaryCids?.updateId;
      const haveCids = allocationCids != null && allocationCids.length === specs.length;
      if (!haveCids && !updateId) {
        throw new Error(
          'order funding: wallet returned neither the created allocation cids nor an updateId',
        );
      }

      const fundRes = await operator.fundOrder({
        orderCid,
        // The wallet accepted the OrderAllocationRequest in the funding batch,
        // so it is already consumed; Order_Fund derives the expected specs from
        // the order itself and binds the created allocations.
        ...(haveCids
          ? { allocationCids: allocationCids as ContractId<'Allocation'>[] }
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
        await ledger.cancelOrder(
          orderCid,
          bindRes.allocationRequestCid as string,
        );
        cancelNote = ' The bound order and its funding request were cancelled.';
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
  cancelOrder: (orderId: string, allocationRequestCid?: string) =>
    fetchJson<void>(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      ...(allocationRequestCid
        ? { body: JSON.stringify({ allocationRequestCid }) }
        : {}),
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
        baseAmount: formatDecimal10(params.baseAmount),
        quoteAmount: formatDecimal10(params.quoteAmount),
        requestedAt,
      }),
    });
    const holdingInputs = [
      params.baseHoldingCids ?? [],
      params.quoteHoldingCids ?? [],
      [],
    ];
    const factories = await Promise.all(
      req.allocations.map((allocation, index) =>
        discoverAllocationFactory({
          admin: allocation.admin,
          settlement: req.settlement,
          allocation,
          requestedAt,
          inputHoldingCids: holdingInputs[index] ?? [],
          actors: [recipient],
        }),
      ),
    );
    const walletRes = await handToWallet({
      kind: 'add-liquidity',
      requestCid: req.requestCid,
      settlement: req.settlement,
      allocations: req.allocations,
      requestedAt,
      factoryCids: factories.map((f) => f.factoryCid),
      allocationFactoryExtraArgs: factories.map((f) => f.extraArgs),
      // The request lives in our own DAR; accept needs no registry context.
      allocationRequestExtraArgs: EMPTY_EXTRA_ARGS,
      disclosure: factories.flatMap((f) => f.disclosure),
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
    // A wallet-accept flow leaves evidence after consuming the request. A
    // direct-allocation integration instead settles against the live request.
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
            minLpTokens: formatDecimal10(params.minLpTokens),
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
            minLpTokens: formatDecimal10(params.minLpTokens),
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
        `remove-liquidity: insufficient unlocked ${params.lpInstrumentId} balance to cover ${lpTokensToRedeem}`,
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
    const holdingInputs = [[], [], holderLpHoldingCids];
    const factories = await Promise.all(
      req.allocations.map((allocation, index) =>
        discoverAllocationFactory({
          admin: allocation.admin,
          settlement: req.settlement,
          allocation,
          requestedAt,
          inputHoldingCids: holdingInputs[index] ?? [],
          actors: [params.holder],
        }),
      ),
    );
    const walletRes = await handToWallet({
      kind: 'remove-liquidity',
      requestCid: req.requestCid,
      settlement: req.settlement,
      allocations: req.allocations,
      requestedAt,
      factoryCids: factories.map((f) => f.factoryCid),
      allocationFactoryExtraArgs: factories.map((f) => f.extraArgs),
      allocationRequestExtraArgs: EMPTY_EXTRA_ARGS,
      disclosure: factories.flatMap((f) => f.disclosure),
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
  const method = init.method ?? 'GET';
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...apiAuthHeaders(path, method),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
