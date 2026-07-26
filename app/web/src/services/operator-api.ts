// Typed client for the operator backend HTTP API. The dApp uses this
// to compose orchestration calls; trader-authority actions go through
// `wallet/handoff.ts` instead.

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

export interface PoolSlice {
  allocationCid: ContractId<"Allocation">;
  amount: Decimal;
}

export interface Pool {
  contractId: ContractId<"Pool">;
  operator: Party;
  lpRegistrar: Party;
  admin: Party;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  lpInstrumentId: { admin: Party; id: string };
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
  pair: string;
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

/** A test balance seeded onto a freshly created testnet party. */
export interface TestnetAirdrop {
  instrumentId: string;
  amount: Decimal;
}

export interface TestnetPartyResult {
  partyId: Party;
  airdrops: TestnetAirdrop[];
}

/**
 * What the testnet relay reports for a submitted tree. `createdEvents` is the
 * transaction's created contracts; it is optional here so a caller can still
 * fall back to operator-discovery from the `updateId` alone.
 */
export interface TestnetSubmitResult {
  updateId: string;
  createdEvents?: Array<{ contractId: string; templateId: string }>;
}

export class OperatorApi {
  constructor(private readonly baseUrl: string) {}

  async listPools(): Promise<Pool[]> {
    return this.get<Pool[]>("/v1/pools");
  }

  async computeSwapQuote(req: {
    poolId: string;
    inputInstrumentId: string;
    inputAmount: Decimal;
  }): Promise<{ outputAmount: Decimal }> {
    return this.post("/v1/swaps/quote", req);
  }

  // Operator builds (in Daml) the swapper's prefunded input-allocation spec +
  // settlement; the wallet authors that spec, then swap() settles with the
  // created allocation cid. The spec/settlement are opaque pass-through wire
  // objects here — the wallet (commands.ts) consumes their typed shape.
  async requestSwap(req: {
    poolCid: ContractId<"Pool">;
    swapper: Party;
    inputInstrumentId: string;
    inputAmount: Decimal;
  }): Promise<{
    allocationSpec: unknown;
    settlement: unknown;
    factoryCid: ContractId<"AllocationFactory">;
    allocationFactoryExtraArgs: V2ExtraArgs;
    allocationFactoryDisclosure: DisclosedContract[];
  }> {
    return this.post("/v1/pools/swap/request", req);
  }

  async swap(req: {
    poolCid: ContractId<"Pool">;
    swapperAccount: { owner: Party; provider: Party | null; id: string };
    inputInstrumentId: string;
    inputAmount: Decimal;
    minOutputAmount: Decimal;
    // Either the explicit created cid, or an updateId for operator-discovery.
    swapperAllocationCid?: ContractId<"Allocation">;
    updateId?: string;
  }): Promise<unknown> {
    return this.post("/v1/pools/swap", req);
  }

  async listRfqs(): Promise<{
    rfqs: LedgerRfq[];
    quotes: LedgerRfqQuote[];
  }> {
    return this.get("/v1/rfq");
  }

  async createRfq(req: {
    trader: Party;
    rfqId: string;
    pair: string;
    side: "RFQ_Buy" | "RFQ_Sell";
    size: Decimal;
    expiresAt: string;
    whitelist: Party[];
    createdAt: string;
  }): Promise<{ rfqCid: ContractId<"Rfq"> }> {
    return this.post("/v1/rfq", req);
  }

  async cancelRfq(rfqCid: ContractId<"Rfq">): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/v1/rfq/${encodeURIComponent(rfqCid)}/cancel`,
      { method: "POST" },
    );
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  }

  async acceptRfq(req: {
    rfqCid: ContractId<"Rfq">;
    acceptedQuoteCid: ContractId<"RfqQuote">;
    consideredQuoteCids: ContractId<"RfqQuote">[];
    admin: Party;
    now: string;
  }): Promise<RfqAcceptResult> {
    return this.post("/v1/rfq/accept", req);
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
  }> {
    return this.post("/v1/orders/bind", req);
  }

  // === testnet onboarding ====================================================
  //
  // These routes are testnet-only: the backend registers them only when it runs
  // with DEX_TESTNET_ONBOARDING=1, so on any other deployment they 404.

  /**
   * Allocate a demo party on this deployment's participant and seed it with the
   * configured test balances. `label` is display-only. Subject to the
   * deployment's daily cap.
   */
  async createTestnetParty(
    req: { label?: string } = {},
  ): Promise<TestnetPartyResult> {
    return this.post("/v1/testnet/party", req);
  }

  /** Whether the given party is hosted on this deployment's participant. */
  async getTestnetHosting(party: Party): Promise<{ hostedHere: boolean }> {
    return this.get(
      `/v1/testnet/hosting?party=${encodeURIComponent(party)}`,
    );
  }

  /**
   * Submit a command tree for a party this deployment hosts. The body carries
   * the party and the commands only: the backend owns actAs/readAs, the user id
   * and the disclosures, so the browser needs no operator credential. Rejects
   * with 403 for a party the deployment does not host and 429 at the cap.
   */
  async submitTestnetCommands(
    req: { party: Party; commands: unknown[] },
    signal?: AbortSignal,
  ): Promise<TestnetSubmitResult> {
    return this.post("/v1/testnet/submit", req, signal);
  }

  // === admin =================================================================

  async createPair(req: {
    admin: Party;
    baseInstrumentId: string;
    quoteInstrumentId: string;
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
    admin: Party;
    baseInstrumentId: string;
    quoteInstrumentId: string;
    lpInstrumentId: string;
    feeBps: number;
  }): Promise<{ poolCid: ContractId<"Pool"> }> {
    return this.post("/v1/admin/pools", req);
  }

  async fundOrder(req: {
    orderCid: ContractId<"Order">;
    // Either the explicit created cid, or an updateId for operator-discovery.
    allocationCid?: ContractId<"Allocation">;
    updateId?: string;
    // The OrderAllocationRequest from bind, consumed by Order_Fund so it does
    // not linger after funding.
    allocationRequestCid?: ContractId<"OrderAllocationRequest">;
  }): Promise<{ orderCid: ContractId<"Order"> }> {
    return this.post("/v1/orders/fund", req);
  }

  // === internals ============================================================

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  private async post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
}
