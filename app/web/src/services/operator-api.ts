// Typed client for the operator backend HTTP API. The dApp uses this
// to compose orchestration calls. Allocation-backed trader actions go
// through `wallet/handoff.ts`; hosted RFQ routes are the documented relay
// exception.

import { apiAuthHeaders } from "./api-auth";

export type Party = string;
export type ContractId<_T> = string;
export type Decimal = string;

export interface V2ExtraArgs {
  context: { values: Record<string, unknown> };
  meta: { values: Record<string, unknown> };
}

export interface DisclosedContract {
  contractId: string;
  templateId: string;
  contractKeyHash?: string;
  // Canton's JSON Ledger API disclosed-contract field (was mis-named `payloadBlob`).
  createdEventBlob: string;
  synchronizerId?: string;
}

export interface AllocationFactorySurface {
  factoryCid: ContractId<"AllocationFactory">;
  extraArgs: V2ExtraArgs;
  disclosure: DisclosedContract[];
}

export interface SwapQuoteBinding {
  expectedPoolId: string;
  poolStateCid: ContractId<"PoolState">;
  inputSliceCid: ContractId<"PoolSlice">;
  outputSliceCids: ContractId<"PoolSlice">[];
  minOutputAmount: Decimal;
}

export interface PoolSlice {
  allocationCid: ContractId<"Allocation">;
  amount: Decimal;
}

export interface InstrumentId {
  admin: Party;
  id: string;
}

export interface Pool {
  contractId: ContractId<"Pool">;
  operator: Party;
  lpRegistrar: Party;
  baseInstrumentId: InstrumentId;
  quoteInstrumentId: InstrumentId;
  lpInstrumentId: InstrumentId;
  feeBps: number;
  status: "Active" | "Paused" | "Unfunded";
  reserves: { baseAmount: Decimal; quoteAmount: Decimal };
  totalLpSupply: Decimal;
  baseSlices: PoolSlice[];
  quoteSlices: PoolSlice[];
  publicReaders: Party[] | null;
}

export interface PolicyReceipt {
  policyVersion: string;
  policyHash: string;
  rfqId: string;
  rankedDealers: {
    party: Party;
    rank: number;
    price: Decimal;
    tier: string;
  }[];
  acceptedDealer: Party;
  acceptedRank: number;
  consideredCount: number;
  signedBy: Party;
  signedAt: string;
  signature: string;
}

export interface RfqAcceptResult {
  tradeCid: ContractId<"MatchedTrade">;
  receipt: PolicyReceipt;
}

export interface LedgerRfq {
  contractId: ContractId<"Rfq">;
  trader: Party;
  operator: Party;
  rfqId: string;
  baseInstrumentId: { admin: Party; id: string };
  quoteInstrumentId: { admin: Party; id: string };
  side: "RFQ_Buy" | "RFQ_Sell";
  size: Decimal;
  expiresAt: string;
  whitelist: Party[];
  createdAt: string;
}

export interface LedgerRfqQuote {
  contractId: ContractId<"RfqQuote">;
  dealer: Party;
  trader: Party;
  operator: Party;
  rfqId: string;
  price: Decimal;
  expiresAt: string;
  postedAt: string;
  tier: "TierTrusted" | "TierWhitelist";
}

export class OperatorApi {
  constructor(private readonly baseUrl: string) {}

  async listPools(): Promise<Pool[]> {
    return this.get<Pool[]>("/v1/pools");
  }

  async computeSwapQuote(req: {
    poolId: string;
    // Full instrument identity: the backend decides the swap side by {admin, id}
    // equality, so a same-symbol cross-admin pair is unambiguous.
    inputInstrumentId: InstrumentId;
    inputAmount: Decimal;
  }): Promise<{ outputAmount: Decimal }> {
    return this.post("/v1/swaps/quote", req);
  }

  async getAllocationFactory(req: {
    admin: Party;
    choiceArguments: Record<string, unknown>;
  }): Promise<AllocationFactorySurface> {
    return this.post("/v1/registry/allocation-factory", req);
  }

  // Operator builds the per-admin allocation specs against one pool snapshot and
  // a SwapAllocationRequest carrying them; the wallet authorizes them and swap()
  // settles that same quote binding.
  async requestSwap(req: {
    poolCid: ContractId<"Pool">;
    swapper: Party;
    // Full instrument identity: the swap choice decides side by {admin, id}
    // equality, so USD@A and USD@B are unambiguous.
    inputInstrumentId: InstrumentId;
    inputAmount: Decimal;
    minOutputAmount: Decimal;
  }): Promise<{
    // One spec per (swapper, admin): input admin first, then output admin; one
    // combined spec for a single-admin swap.
    allocationSpecs: unknown;
    swapRequestCid: ContractId<"SwapAllocationRequest">;
    settlement: unknown;
    quoteBinding: SwapQuoteBinding;
  }> {
    return this.post("/v1/pools/swap/request", req);
  }

  async swap(req: {
    poolCid: ContractId<"Pool">;
    swapperAccount: { owner: Party; provider: Party | null; id: string };
    inputInstrumentId: InstrumentId;
    inputAmount: Decimal;
    minOutputAmount: Decimal;
    quoteBinding: SwapQuoteBinding;
    // The created cids in canonical admin order (input admin first), or an
    // updateId for operator-discovery.
    swapperAllocationCids?: ContractId<"Allocation">[];
    updateId?: string;
  }): Promise<unknown> {
    return this.post("/v1/pools/swap", req);
  }

  /** Scoped to one party: the operator observes every RFQ and quote. */
  async listRfqs(owner: Party): Promise<{
    rfqs: LedgerRfq[];
    quotes: LedgerRfqQuote[];
  }> {
    return this.get(`/v1/rfq?owner=${encodeURIComponent(owner)}`);
  }

  async createRfq(req: {
    trader: Party;
    rfqId: string;
    baseInstrumentId: { admin: Party; id: string };
    quoteInstrumentId: { admin: Party; id: string };
    side: "RFQ_Buy" | "RFQ_Sell";
    size: Decimal;
    expiresAt: string;
    whitelist: Party[];
    createdAt: string;
  }): Promise<{ rfqCid: ContractId<"Rfq"> }> {
    return this.post("/v1/rfq", req);
  }

  async cancelRfq(rfqCid: ContractId<"Rfq">): Promise<void> {
    const path = `/v1/rfq/${encodeURIComponent(rfqCid)}/cancel`;
    const res = await fetch(
      `${this.baseUrl}${path}`,
      { method: "POST", headers: apiAuthHeaders(path, "POST") },
    );
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  }

  async acceptRfq(req: {
    rfqCid: ContractId<"Rfq">;
    acceptedQuoteCid: ContractId<"RfqQuote">;
    consideredQuoteCids: ContractId<"RfqQuote">[];
    now: string;
  }): Promise<RfqAcceptResult> {
    return this.post("/v1/rfq/accept", req);
  }

  // === matched-trade settlement ============================================
  // Drives an accepted RFQ's MatchedTrade to settlement: request the per-
  // authorizer TradeAllocationRequests, the wallet funds the connected party's
  // side, then the operator settles the cross-admin batches.

  async requestMatchedTradeAllocations(req: {
    tradeCid: ContractId<"MatchedTrade">;
  }): Promise<{
    // One request per non-venue authorizer; each carries the specs that
    // authorizer must author (spanning one or two admins) so the wallet can
    // accept it and author every AllocationFactory_Allocate in one command.
    allocationRequests: Array<{
      requestCid: ContractId<"TradeAllocationRequest">;
      settlement: unknown;
      requestedAt: string;
      allocations: unknown;
    }>;
  }> {
    return this.post("/v1/matched-trades/request-allocations", req);
  }

  async settleMatchedTrade(req: {
    tradeCid: ContractId<"MatchedTrade">;
    // The connected party's authored allocation cids grouped by registry admin,
    // or an updateId for operator-discovery. The operator derives the trade's
    // legs from the trade itself and assembles the counterparty's side; it never
    // settles caller-supplied transfer legs.
    allocationCidsByAdmin?: Record<Party, ContractId<"Allocation">[]>;
    updateId?: string;
    // Trade allocation requests still active for the operator to consume. The
    // wallet accept archives the connected party's own, so this is normally [].
    allocationRequestCids?: ContractId<"TradeAllocationRequest">[];
    // When set, RFQ fees accrue against this pair on settle; omitted = no accrual.
    dexPairCid?: ContractId<"DexPair">;
  }): Promise<{ result: unknown }> {
    return this.post("/v1/matched-trades/settle", req);
  }

  async bindOrder(req: {
    // Either the explicit created cid (full-tree wallet), or an updateId for
    // operator-discovery (updateId-only wallet, e.g. CIP-0103 SDK / PartyLayer).
    fundingRequestCid?: ContractId<"OrderFundingRequest">;
    updateId?: string;
    settlementRef: string;
  }): Promise<{
    orderCid: ContractId<"Order">;
    allocationRequestCid: ContractId<"OrderAllocationRequest">;
    settlement: unknown;
    // One spec per distinct admin: the lock-admin funding spec, plus a
    // counter-admin receipt for a cross-admin pair; one for a single-admin pair.
    allocationSpecs: unknown;
  }> {
    return this.post("/v1/orders/bind", req);
  }

  // === admin =================================================================

  async createPair(req: {
    baseInstrumentId: InstrumentId;
    quoteInstrumentId: InstrumentId;
    tradingMode: "TM_OrderBook" | "TM_Pool" | "TM_Both";
    feeModel: { makerFeeBps: number; takerFeeBps: number; poolFeeBps: number };
    active?: boolean;
  }): Promise<{ pairCid: ContractId<"DexPair"> }> {
    return this.post("/v1/admin/pairs", req);
  }

  async setPairActive(
    pairCid: ContractId<"DexPair">,
    active: boolean,
  ): Promise<{ pairCid: ContractId<"DexPair"> }> {
    return this.post(
      `/v1/admin/pairs/${encodeURIComponent(pairCid)}/active`,
      { active },
    );
  }

  async updatePairFeeModel(
    pairCid: ContractId<"DexPair">,
    newFeeModel: { makerFeeBps: number; takerFeeBps: number; poolFeeBps: number },
  ): Promise<{ pairCid: ContractId<"DexPair"> }> {
    return this.post(
      `/v1/admin/pairs/${encodeURIComponent(pairCid)}/fee-model`,
      { newFeeModel },
    );
  }

  async createPool(req: {
    lpRegistrar: Party;
    baseInstrumentId: InstrumentId;
    quoteInstrumentId: InstrumentId;
    lpInstrumentId: string;
    feeBps: number;
  }): Promise<{ poolCid: ContractId<"Pool"> }> {
    return this.post("/v1/admin/pools", req);
  }

  async fundOrder(req: {
    orderCid: ContractId<"Order">;
    // The created cids (one per admin; Order_Fund binds each by allocation-view
    // admin, so order is immaterial), or an updateId for operator-discovery.
    allocationCids?: ContractId<"Allocation">[];
    updateId?: string;
    // The OrderAllocationRequest from bind, consumed by Order_Fund so it does
    // not linger after funding.
    allocationRequestCid?: ContractId<"OrderAllocationRequest">;
  }): Promise<{ orderCid: ContractId<"Order"> }> {
    return this.post("/v1/orders/fund", req);
  }

  // === internals ============================================================

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: apiAuthHeaders(path, "GET"),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...apiAuthHeaders(path, "POST"),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
}
