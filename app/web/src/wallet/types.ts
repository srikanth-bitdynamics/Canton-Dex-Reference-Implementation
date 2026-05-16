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
 * Trader requests a swap. The wallet first creates a prefunded
 * V2.Allocation against the pool's settlement reference, then creates
 * a SwapRequest carrying that allocation cid. Operator drives Pool_Swap
 * afterwards.
 */
export interface RequestSwapIntent {
  kind: "request-swap";
  poolId: string;
  inputInstrumentId: string;
  inputAmount: string;
  outputInstrumentId: string;
  minOutputAmount: string;
  inputHoldingCids: ContractId<"Holding">[];
  factoryCid: ContractId<"AllocationFactory">;
  operator: Party;
  admin: Party;
}

/** Trader provides liquidity. */
export interface AddLiquidityIntent {
  kind: "add-liquidity";
  poolId: string;
  baseAmount: string;
  quoteAmount: string;
  baseHoldingCids: ContractId<"Holding">[];
  quoteHoldingCids: ContractId<"Holding">[];
  minLpTokens: string;
  factoryCid: ContractId<"AllocationFactory">;
  operator: Party;
  admin: Party;
}

/**
 * Trader completes the LP-burn half of remove-liquidity. The operator
 * has already exercised Pool_RemoveLiquidity, which produced an
 * LPBurnRequest. The wallet exercises LPTokenPolicy_AcceptBurn against
 * the trader's locked LP holding cid.
 */
export interface AcceptLpBurnIntent {
  kind: "accept-lp-burn";
  burnRequestCid: ContractId<"LPBurnRequest">;
  holderHoldingCid: ContractId<"Holding">;
  hint: { lpInstrumentId: string; amount: string };
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
  | AcceptLpBurnIntent
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
}

export interface WalletAccount {
  party: Party;
  /** Display label the wallet chose for the user. */
  label?: string;
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
