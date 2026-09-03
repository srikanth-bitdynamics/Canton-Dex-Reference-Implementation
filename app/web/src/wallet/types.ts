// Wallet provider interface.
//
// The dApp NEVER signs as the trader. It builds an intent describing the
// requested ledger action and hands it to the trader's wallet.
//
// This file defines:
//   - the intent shapes (mirror the on-ledger choices the trader signs)
//   - the WalletProvider interface every concrete wallet integration implements
//   - the connection state shape surfaced to the UI
//
// The dApp imports `handToWallet` from `./handoff` which dispatches to
// the active provider selected in the wallet store.

import type { Holding, InstrumentId } from "@/types/contracts";

export type Party = string;
export type ContractId<_T> = string;

export interface V2Metadata {
  values: Record<string, string>;
}

// === Token Standard V2 wire shapes =======================================
// Mirror the Daml AllocationV2 types. The dApp receives these (the specs the
// wallet must author) from the operator-backend `/request` response and
// forwards them verbatim into AllocationFactory_Allocate. `owner` is
// nullable: the canonical mint/burn accounts carry `owner = null`.

export interface V2Account {
  owner: Party | null;
  provider: Party | null;
  id: string;
}

export interface V2TransferLegSide {
  transferLegId: string;
  side: "SenderSide" | "ReceiverSide";
  otherside: V2Account;
  amount: string;
  instrumentId: string;
  meta: V2Metadata;
}

export interface V2AllocationSpecification {
  admin: Party;
  authorizer: V2Account;
  transferLegSides: V2TransferLegSide[];
  settlementDeadline: string | null;
  nextIterationFunding: Record<string, string> | null;
  committed: boolean;
  meta: V2Metadata;
}

export interface V2SettlementInfo {
  executors: Party[];
  id: string;
  cid: string | null;
  meta: V2Metadata;
}

export interface V2ExtraArgs {
  context: { values: Record<string, unknown> };
  meta: { values: Record<string, unknown> };
}

export interface DisclosedContract {
  contractId: string;
  templateId: string;
  contractKeyHash?: string;
  /** Base64-encoded created event used by the JSON Ledger API. */
  createdEventBlob: string;
  synchronizerId?: string;
}

// === intent shapes ========================================================
//
// Each intent corresponds to a trader-authority Daml choice (or compose
// of choices in one submission). The wallet provider translates the
// intent into a Daml command tree and submits via its signing path.

/**
 * Lock the funds a pending order requires. The wallet accepts the
 * OrderAllocationRequest and authors its specifications via BatchingUtilityV2:
 * the funding allocation under the lock admin, plus a zero-funding receipt under
 * the counter admin for a cross-admin pair (one spec for a single-admin pair).
 * Order_Fund binds each by matching its allocation view to the request's
 * per-admin spec; the created cids (or an updateId) drive that call.
 * `allocations`, `factoryCids`, and `allocationFactoryExtraArgs` are parallel:
 * the lock-admin funding spec first.
 */
export interface FundOrderIntent {
  kind: "fund-order";
  requestCid: ContractId<"OrderAllocationRequest">;
  settlement: V2SettlementInfo;
  allocations: V2AllocationSpecification[];
  requestedAt: string;
  factoryCids: ContractId<"AllocationFactory">[];
  allocationFactoryExtraArgs: V2ExtraArgs[];
  /** Context for the AllocationRequest_Accept call (empty for the self-registry). */
  allocationRequestExtraArgs: V2ExtraArgs;
  disclosure: DisclosedContract[];
  /** Holdings the wallet should propose to lock for the funding spec. */
  inputHoldingCids: ContractId<"Holding">[];
  /**
   * Hint for the wallet's holding-selection UI: the locked instrument
   * + amount the request requires.
   */
  hint: { instrumentId: string; amount: string };
}

/**
 * Trader places an order: signs an OrderFundingRequest. The operator
 * later observes and exercises OrderFundingRequest_Bind.
 */
export interface PlaceOrderIntent {
  kind: "place-order";
  pair: { base: InstrumentId; quote: InstrumentId };
  side: "Bid" | "Ask";
  limitPrice: string;
  quantity: string;
  expiry: string | null;
  operator: Party;
}

/**
 * Trader requests a swap (DvP). PoolRules_RequestSwap built one specification
 * per (swapper, admin) — the swap-in leg under the input admin, the swap-out
 * receipt under the output admin — and a SwapAllocationRequest carrying them; a
 * single-admin swap collapses to one combined specification. The wallet accepts
 * that request and authors every specification via BatchingUtilityV2 in one
 * command (locking `inputHoldingCids` on the swap-in spec). The created
 * Allocation cids (input admin first) settle through PoolRules_Swap; an
 * updateId-only wallet returns the updateId and the operator recovers them.
 * `allocations`, `factoryCids`, and `allocationFactoryExtraArgs` are parallel.
 */
export interface RequestSwapIntent {
  kind: "request-swap";
  poolId: string;
  requestCid: ContractId<"SwapAllocationRequest">;
  settlement: V2SettlementInfo;
  allocations: V2AllocationSpecification[];
  requestedAt: string;
  factoryCids: ContractId<"AllocationFactory">[];
  allocationFactoryExtraArgs: V2ExtraArgs[];
  /** Context for the AllocationRequest_Accept call (empty for the self-registry). */
  allocationRequestExtraArgs: V2ExtraArgs;
  disclosure: DisclosedContract[];
  inputHoldingCids: ContractId<"Holding">[];
}

/**
 * Normalize fragmented holdings so a later swap can lock an exact
 * funding amount without over-locking change. The registry controls
 * these choices jointly with the trader and admin.
 */
export interface SplitHoldingIntent {
  kind: "split-holding";
  holdingCid: ContractId<"Holding">;
  admin: Party;
  splitAmount: string;
}

export interface MergeHoldingsIntent {
  kind: "merge-holdings";
  holdingCid: ContractId<"Holding">;
  otherCid: ContractId<"Holding">;
  admin: Party;
}

/**
 * Trader provides liquidity (DvP). The operator has created a
 * LiquidityAllocationRequest; the wallet authors the three allocations it
 * names — base deposit + quote deposit (under pool.admin) and the LP-token
 * receipt (under pool.lpRegistrar) — via a CreateAndExercise of the token standard's
 * `BatchingUtilityV2.ExecuteBatch`, which accepts the request (leaving the
 * acceptance receipt) and authors all three inside ONE Daml transaction / one
 * top-level command for gateways that accept one command. `allocations`
 * is the canonical order [base deposit, quote deposit, LP receipt].
 * `factoryCids` and `allocationFactoryExtraArgs` are parallel to that order;
 * each pair comes from registry discovery for the exact Allocate arguments.
 */
export interface AddLiquidityIntent {
  kind: "add-liquidity";
  requestCid: ContractId<"LiquidityAllocationRequest">;
  settlement: V2SettlementInfo;
  allocations: V2AllocationSpecification[];
  requestedAt: string;
  factoryCids: ContractId<"AllocationFactory">[];
  allocationFactoryExtraArgs: V2ExtraArgs[];
  /** Context for the AllocationRequest_Accept call (empty for the self-registry). */
  allocationRequestExtraArgs: V2ExtraArgs;
  disclosure: DisclosedContract[];
  baseHoldingCids: ContractId<"Holding">[];
  quoteHoldingCids: ContractId<"Holding">[];
}

/**
 * Trader removes liquidity (DvP). Symmetric to add: the wallet
 * authors the three allocations the request names — base receipt + quote
 * receipt (under pool.admin) and the LP burn-sender (under pool.lpRegistrar,
 * locking `lpHoldingCids`) — in canonical order [base receipt, quote receipt,
 * LP burn-sender]. The factory/context arrays use the same order.
 */
export interface RemoveLiquidityIntent {
  kind: "remove-liquidity";
  requestCid: ContractId<"LiquidityAllocationRequest">;
  settlement: V2SettlementInfo;
  allocations: V2AllocationSpecification[];
  requestedAt: string;
  factoryCids: ContractId<"AllocationFactory">[];
  allocationFactoryExtraArgs: V2ExtraArgs[];
  /** Context for the AllocationRequest_Accept call (empty for the self-registry). */
  allocationRequestExtraArgs: V2ExtraArgs;
  disclosure: DisclosedContract[];
  /**
   * ALL the holder's unlocked LP holdings to lock for the burn — an LP
   * position can be fragmented across several holdings after multiple
   * adds, so the burn-sender allocation must be able to draw from all of
   * them, not just the first.
   */
  lpHoldingCids: ContractId<"Holding">[];
}

/**
 * Trader funds their side of an accepted RFQ's MatchedTrade. The operator's
 * MatchedTrade_RequestAllocations created a TradeAllocationRequest carrying one
 * specification per admin this authorizer touches; the wallet accepts it and
 * authors every AllocationFactory_Allocate via BatchingUtilityV2 in one command
 * — the same standard path swap and order funding use. The created Allocation
 * cids (or an updateId) drive the operator's MatchedTrade_Settle.
 */
export interface FundMatchedTradeIntent {
  kind: "fund-matched-trade";
  requestCid: ContractId<"TradeAllocationRequest">;
  settlement: V2SettlementInfo;
  allocations: V2AllocationSpecification[];
  requestedAt: string;
  factoryCids: ContractId<"AllocationFactory">[];
  allocationFactoryExtraArgs: V2ExtraArgs[];
  /** Context for the AllocationRequest_Accept call (empty for the self-registry). */
  allocationRequestExtraArgs: V2ExtraArgs;
  disclosure: DisclosedContract[];
  /** Holdings the wallet locks for the funding (sender-leg) spec. */
  inputHoldingCids: ContractId<"Holding">[];
}

/**
 * Self-author a `SessionAttestation` so the session service (BFF) can mint the
 * connected party a scoped caller token. Only the party's own wallet can create
 * it (sole signatory) — that is the proof of control the backend reads.
 */
export interface AttestSessionIntent {
  kind: "attest-session";
  /** The operator/verifier party that observes the attestation. */
  verifier: Party;
  /** The single-use challenge the session service issued. */
  nonce: string;
  /** ISO-8601 UTC expiry the session service issued for this challenge. */
  expiresAt: string;
}

export type WalletIntent =
  | FundOrderIntent
  | PlaceOrderIntent
  | RequestSwapIntent
  | SplitHoldingIntent
  | MergeHoldingsIntent
  | AddLiquidityIntent
  | RemoveLiquidityIntent
  | FundMatchedTradeIntent
  | AttestSessionIntent;

// === provider result + status ============================================

export interface WalletResult {
  /** Submitting party that signed the resulting transaction. */
  submittedBy: Party;
  /** Contract id of the primary contract created/touched. */
  primaryCid: string;
  /** Optional: any auxiliary cids the wallet wants to surface. */
  auxiliaryCids?: Record<string, string>;
  /**
   * For allocation-authoring intents (add/remove-liquidity, request-swap,
   * fund-order), the created V2.Allocation cids in the SAME order as the intent's
   * `allocations` — i.e. the order the AllocationFactory_Allocate commands were
   * emitted (input/lock admin first). The dApp forwards these to the
   * operator-backend `/settle`, `/swap`, or `/fund` call. An updateId-only
   * provider omits this array and instead returns `auxiliaryCids.updateId`, which
   * lets the operator recover the allocations from the transaction tree.
   */
  createdAllocationCids?: string[];
  /**
   * Created Holding cids for holding-normalization intents such as
   * split/merge. Providers that cannot surface them may omit this and
   * let the caller re-fetch holdings from the ledger.
   */
  createdHoldingCids?: string[];
}

export interface WalletAccount {
  party: Party;
  /** Display label the wallet chose for the user. */
  label?: string;
}

/**
 * Thrown by providers that cannot drive the LP DvP flow (add/remove
 * liquidity) because they can't return the created allocation cids the
 * `/settle` call requires. The UI uses this to reject unsupported providers
 * before any holdings are locked.
 */
export class LiquidityAllocationUnsupportedError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `LP add/remove liquidity is not supported by the "${providerId}" wallet ` +
        `provider (it cannot return created allocation cids for /settle). ` +
        `Select a wallet provider with full DvP support.`,
    );
    this.name = "LiquidityAllocationUnsupportedError";
  }
}

export type WalletConnectionStatus =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected"; account: WalletAccount; providerId: string }
  | { kind: "error"; message: string };

// === wallet discovery ====================================================
//
// A concrete, connectable wallet surfaced by a provider's optional
// `listWallets()`. The combined picker (`./detection`) queries every
// detection-capable provider, merges the results, and shows one list; each
// row routes back to its owning provider via `providerId`, and — when the
// provider connects to more than one underlying wallet (the dapp-sdk gateway
// vs an injected extension; PartyLayer's Loop/Console/Nightly/Send) — to the
// specific `walletId` passed to `connect(walletId)`.

export interface DetectedWallet {
  /** Unique id within the merged picker. Convention: `${providerId}:${walletId}`. */
  readonly id: string;
  /** Owning provider id (a `WalletProviderId`) — routes the connect. */
  readonly providerId: string;
  /**
   * Sub-wallet id within the owning provider, passed to `connect(walletId)`.
   * dapp-sdk: the discovered providerId (`remote:<url>`, `browser:*`). PartyLayer:
   * the adapter wallet id (`loop`, `console`, …). Omitted when the provider has a
   * single implicit wallet.
   */
  readonly walletId?: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  /**
   * Detected install/reachability: `true` installed/reachable, `false`
   * explicitly not-installed (shown greyed with an install link), `undefined`
   * when the provider has no opinion.
   */
  readonly installed?: boolean;
  /** Where to install the wallet if it isn't yet. */
  readonly installUrl?: string;
  /** Short route/kind label shown on the right of the row (e.g. "Gateway",
   * "Loop", "Extension", "Injected"). */
  readonly badge?: string;
}

// === provider interface ==================================================

export interface WalletProvider {
  /** Stable identifier; used in logs and to remember the user's choice. */
  readonly id: string;
  /** Human-readable label for the Connect UI. */
  readonly label: string;

  /**
   * Initialize SDKs, open the wallet UI, return once connected. When the
   * combined picker has already chosen a specific wallet the provider owns,
   * `walletId` names it (the provider connects directly to that wallet and
   * skips its own picker); when omitted, the provider runs its native default
   * flow. Providers with a single implicit wallet ignore the argument.
   */
  connect(walletId?: string): Promise<WalletAccount>;

  /** Terminate the session. Idempotent. */
  disconnect(): Promise<void>;

  /**
   * Optional wallet discovery. Providers that front more than one concrete
   * wallet (dapp-sdk: injected + announced + a CIP-103 gateway; PartyLayer: its
   * multi-wallet catalog) enumerate them here so the combined picker can show
   * only wallets that are actually available. Absence means "single implicit
   * wallet" — the provider is offered as one row.
   */
  listWallets?(): Promise<readonly DetectedWallet[]>;

  /** Current cached status. Sync — call after subscribing to update. */
  getStatus(): WalletConnectionStatus;

  /** Subscribe to status transitions. Returns an unsubscribe fn. */
  onStatusChange(cb: (s: WalletConnectionStatus) => void): () => void;

  /**
   * Submit an intent to the connected wallet. The provider is
   * responsible for translating the intent into a Daml command tree
   * and submitting through its signing transport. Rejects on user
   * cancel, timeout, or any submission error.
   */
  submit(intent: WalletIntent): Promise<WalletResult>;

  /**
   * Optional wallet-native balance source. Providers that can proxy ledger reads
   * through the connected wallet should return the owner's visible holdings here;
   * callers fall back to the operator backend when this is absent or fails.
   */
  listHoldings?(owner: Party): Promise<Holding[]>;
}
