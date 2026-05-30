// Wallet provider interface.
//
// The dApp NEVER signs as the trader. It builds an "intent" describing
// what should happen on-ledger (allocation accept, order placement,
// swap funding, LP burn accept) and hands it to the trader's wallet.
//
// This file defines:
//   - the intent shapes (mirror the on-ledger choices the trader signs)
//   - the WalletProvider interface every concrete wallet integration
//     must implement (WalletConnect, CIP-0103 native, Dfns, mock, ...)
//   - the connection state shape surfaced to the UI
//
// The dApp imports `handToWallet` from `./handoff` which dispatches to
// whatever provider is currently active. Swapping providers later is
// adding one file under `./wallet/` and wiring it in the registry.

export type Party = string;
export type ContractId<_T> = string;

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
  meta: Record<string, string>;
}

export interface V2AllocationSpecification {
  admin: Party;
  authorizer: V2Account;
  transferLegSides: V2TransferLegSide[];
  settlementDeadline: string | null;
  nextIterationFunding: Record<string, string> | null;
  committed: boolean;
  meta: Record<string, string>;
}

export interface V2SettlementInfo {
  executors: Party[];
  id: string;
  cid: string | null;
  meta: Record<string, string>;
}

// === intent shapes ========================================================
//
// Each intent corresponds to a trader-authority Daml choice (or compose
// of choices in one submission). The wallet provider translates the
// intent into a Daml command tree and submits via its signing path.

/**
 * Trader accepts a V2.AllocationRequest (TradeAllocationRequest or
 * OrderAllocationRequest). Wallet must compose this with a
 * V2.AllocationFactory_Allocate call in the SAME submission so the
 * trader's holdings back the allocation.
 */
export interface AcceptAllocationRequestIntent {
  kind: "accept-allocation-request";
  requestCid: ContractId<"AllocationRequest">;
  factoryCid: ContractId<"AllocationFactory">;
  /** Holdings the wallet should propose to lock. */
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
  pair: { base: string; quote: string };
  side: "Bid" | "Ask";
  limitPrice: string;
  quantity: string;
  expiry: string | null;
  operator: Party;
  admin: Party;
}

/**
 * Trader requests a swap (DvP). The operator has built (via Daml
 * PoolRules_RequestSwap) the swapper's prefunded/iterated input-allocation
 * spec; the wallet authors that single allocation via AllocationFactory_Allocate
 * (locking `inputHoldingCids`), and its created cid is returned as
 * `WalletResult.createdAllocationCids[0]` for the operator settle
 * (PoolRules_Swap). No SwapRequest contract is created.
 */
export interface RequestSwapIntent {
  kind: "request-swap";
  poolId: string;
  allocationSpec: V2AllocationSpecification;
  settlement: V2SettlementInfo;
  factoryCid: ContractId<"AllocationFactory">;
  inputHoldingCids: ContractId<"Holding">[];
}

/**
 * Trader provides liquidity (DvP). The operator has created a
 * LiquidityAllocationRequest; the wallet authors the three allocations it
 * names — base deposit + quote deposit (under `depositFactoryCid` =
 * pool.admin) and the LP-token receipt (under `lpFactoryCid` =
 * pool.lpRegistrar) — by exercising AllocationFactory_Allocate once per
 * spec in ONE submission. `allocations` is the canonical order
 * [base deposit, quote deposit, LP receipt]; the resulting cids come back
 * as `WalletResult.createdAllocationCids` in the same order for /settle.
 */
export interface AddLiquidityIntent {
  kind: "add-liquidity";
  requestCid: ContractId<"LiquidityAllocationRequest">;
  settlement: V2SettlementInfo;
  allocations: V2AllocationSpecification[];
  depositFactoryCid: ContractId<"AllocationFactory">;
  lpFactoryCid: ContractId<"AllocationFactory">;
  baseHoldingCids: ContractId<"Holding">[];
  quoteHoldingCids: ContractId<"Holding">[];
}

/**
 * Trader removes liquidity (DvP). Symmetric to add: the wallet
 * authors the three allocations the request names — base receipt + quote
 * receipt (under `depositFactoryCid` = pool.admin) and the LP burn-sender
 * (under `lpFactoryCid` = pool.lpRegistrar, locking `lpHoldingCid`) — in
 * canonical order [base receipt, quote receipt, LP burn-sender].
 */
export interface RemoveLiquidityIntent {
  kind: "remove-liquidity";
  requestCid: ContractId<"LiquidityAllocationRequest">;
  settlement: V2SettlementInfo;
  allocations: V2AllocationSpecification[];
  depositFactoryCid: ContractId<"AllocationFactory">;
  lpFactoryCid: ContractId<"AllocationFactory">;
  /**
   * ALL the holder's unlocked LP holdings to lock for the burn — an LP
   * position can be fragmented across several holdings after multiple
   * adds, so the burn-sender allocation must be able to draw from all of
   * them, not just the first.
   */
  lpHoldingCids: ContractId<"Holding">[];
}

/**
 * Dealer posts a quote against an open RFQ. Same wallet path; the
 * dealer's wallet signs the RfqQuote create.
 */
export interface PostRfqQuoteIntent {
  kind: "post-rfq-quote";
  rfqCid: ContractId<"Rfq">;
  rfqId: string;
  price: string;
  expiresAt: string;
  postedAt: string;
  tier: "TierTrusted" | "TierWhitelist";
  operator: Party;
  trader: Party;
}

/**
 * Trader accepts an RFQ. Joint trader+operator submission — in
 * production the operator pre-creates a delegation contract so the
 * trader's wallet alone is enough; the operator's authority comes from
 * the delegation. For testnet, the dApp can fall back to having the
 * operator backend co-submit.
 */
export interface AcceptRfqIntent {
  kind: "accept-rfq";
  rfqCid: ContractId<"Rfq">;
  acceptedQuoteCid: ContractId<"RfqQuote">;
  consideredQuoteCids: ContractId<"RfqQuote">[];
  admin: Party;
  operator: Party;
}

export type WalletIntent =
  | AcceptAllocationRequestIntent
  | PlaceOrderIntent
  | RequestSwapIntent
  | AddLiquidityIntent
  | RemoveLiquidityIntent
  | PostRfqQuoteIntent
  | AcceptRfqIntent;

// === provider result + status ============================================

export interface WalletResult {
  /** Submitting party that signed the resulting transaction. */
  submittedBy: Party;
  /** Contract id of the primary contract created/touched. */
  primaryCid: string;
  /** Optional: any auxiliary cids the wallet wants to surface. */
  auxiliaryCids?: Record<string, string>;
  /**
   * For multi-allocation intents (add/remove-liquidity), the created
   * V2.Allocation cids in the SAME order as the intent's `allocations` —
   * i.e. the order the AllocationFactory_Allocate commands were emitted. The
   * dApp forwards these to the operator-backend `/settle` call. Providers
   * that cannot extract created-contract cids from their submit response
   * MUST reject those intents rather than return this empty/partial.
   */
  createdAllocationCids?: string[];
}

export interface WalletAccount {
  party: Party;
  /** Display label the wallet chose for the user. */
  label?: string;
}

/**
 * Thrown by providers that cannot drive the LP DvP flow (add/remove
 * liquidity) because they can't return the created allocation cids the
 * `/settle` call requires — the operator-relay (`token-standard`,
 * `canton-direct`) and the current `walletconnect` paths. LP DvP needs a
 * CIP-0103 wallet (the `sdk` provider) or the dev `mock`.
 */
export class LpDvpUnsupportedError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `LP add/remove liquidity is not supported by the "${providerId}" wallet ` +
        `provider (it cannot return created allocation cids for /settle). ` +
        `Use a CIP-0103 wallet (the SDK provider).`,
    );
    this.name = "LpDvpUnsupportedError";
  }
}

export type WalletConnectionStatus =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected"; account: WalletAccount; providerId: string }
  | { kind: "error"; message: string };

// === provider interface ==================================================

export interface WalletProvider {
  /** Stable identifier; used in logs and to remember the user's choice. */
  readonly id: string;
  /** Human-readable label for the Connect UI. */
  readonly label: string;

  /** Initialize SDKs, open the modal, return once connected. */
  connect(): Promise<WalletAccount>;

  /** Terminate the session. Idempotent. */
  disconnect(): Promise<void>;

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
}
