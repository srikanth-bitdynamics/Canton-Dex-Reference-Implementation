// Operator backend entry point.
//
// B7 source-driven guardrail (encoded structurally):
//
//   - Every flow module submits ledger commands through the shared
//     LedgerSubmitter interface. The set of choice names that appear
//     in `submit({ command: { choice: "..." } })` calls is the
//     operator's choice vocabulary -- audit by grepping that string
//     across the modules.
//   - The set is exactly:
//       Rfq_Accept
//       Order_Fund, Order_Adjust, Order_Cancel
//       OrderFundingRequest_Bind
//       Pool_Initialize, Pool_AddLiquidity, Pool_RemoveLiquidity, Pool_Swap
//       MatchedTrade_RequestAllocations, MatchedTrade_Settle, MatchedTrade_Cancel
//       DexPair_UpdateFeeModel, DexPair_SetActive, DexPair_UpdateTradingMode
//     Plus operator-signed creates of DexPair and Pool (admin seeding).
//     Plus the V2 token-standard choices the operator may compose:
//       AllocationFactory_Allocate (only for committed pool allocations)
//       SettlementFactory_SettleBatch (only via DEX choices)
//       Allocation_Adjust, Allocation_Cancel (only via DEX choices)
//   - Adding a NEW orchestration verb requires either a new contract
//     choice or a composition of existing ones. The backend never
//     synthesizes ledger state via direct create/archive of DEX
//     templates -- that's a guardrail violation.

import type { LedgerSubmitter } from "./ledger/index.js";
import type { RegistryClient } from "@canton-dex/registry-client";

import { AdminService } from "./admin/index.js";
import { OrderService } from "./order/index.js";
import { MatchedTradeService } from "./matched-trade/index.js";
import { PoolService } from "./pool/index.js";
import { RfqService } from "./rfq/index.js";

import type { Party } from "./types.js";

export interface OperatorBackendConfig {
  ledger: LedgerSubmitter;
  registry: RegistryClient;
  operatorParty: Party;
}

export class OperatorBackend {
  readonly rfq: RfqService;
  readonly order: OrderService;
  readonly pool: PoolService;
  readonly matchedTrade: MatchedTradeService;
  readonly admin: AdminService;
  // Exposed for the HTTP shim (read-only routes) and integration tests
  // that need to drive raw ledger commands. Production callers should
  // prefer the typed flow modules.
  readonly ledger: LedgerSubmitter;
  readonly operatorParty: Party;

  constructor(cfg: OperatorBackendConfig) {
    this.ledger = cfg.ledger;
    this.operatorParty = cfg.operatorParty;
    this.rfq = new RfqService(cfg.ledger, cfg.registry, cfg.operatorParty);
    this.order = new OrderService(cfg.ledger, cfg.registry, cfg.operatorParty);
    this.pool = new PoolService(cfg.ledger, cfg.registry, cfg.operatorParty);
    this.matchedTrade = new MatchedTradeService(
      cfg.ledger,
      cfg.registry,
      cfg.operatorParty,
    );
    this.admin = new AdminService(cfg.ledger, cfg.registry, cfg.operatorParty);
  }
}

export * from "./types.js";
export { POLICY_VERSION, verifyReceipt } from "./policy/index.js";
export type { LedgerSubmitter } from "./ledger/index.js";
export { LedgerError } from "./ledger/index.js";
export { InMemoryLedger } from "./ledger/in-memory.js";
export { JsonApiLedger } from "./ledger/json-api.js";
export type { JsonApiConfig } from "./ledger/json-api.js";
