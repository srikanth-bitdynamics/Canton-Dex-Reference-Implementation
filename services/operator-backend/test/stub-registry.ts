import {
  FixedRegistryClient,
  type ContractId,
  type FactoryRefs,
  type Party,
} from "@canton-dex/registry-client";

/** Fixed self-registry used by backend tests that do not exercise discovery. */
export class StubRegistry extends FixedRegistryClient {
  constructor(
    factoriesForAdmin: (admin: Party) => FactoryRefs = () => ({
      allocationFactoryCid: "#alloc:0" as ContractId<"AllocationFactory">,
      settlementFactoryCid: "#settle:0" as ContractId<"SettlementFactory">,
      disclosure: [],
    }),
  ) {
    super(factoriesForAdmin);
  }
}
