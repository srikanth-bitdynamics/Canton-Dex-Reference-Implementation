// Registry client for a deployment that has no off-ledger registry index:
// resolves each admin's Registry.V2 contract straight off the ledger.
//
// Lives in its own module so the testnet server and the operator scripts share
// ONE definition. A copy in a script would drift from the server it is meant
// to be testing, which is exactly the failure mode these scripts exist to
// catch.

import { RegistryClient } from "@canton-dex/registry-client";
import type { ChoiceContextRef, ContractId, DisclosedContract } from "@canton-dex/registry-client";
import { rootLogger } from "../lib/logger.js";

const log = rootLogger.child({ component: "fixed-registry" });

// Lightweight registry client: resolves each admin's Registry.V2 contract off
// the ledger and serves it as that admin's factory. Production deployments use
// a real registry index.
//
// PER-ADMIN, not fixed. Registry.V2 is its own AllocationFactory and
// SettlementFactory, and `AllocationFactory_Allocate` asserts that the spec's
// instrument admin matches the registry the factory belongs to. This DEX runs
// TWO registries -- `CANTON_ADMIN` issues the deposit instruments (dBTC, dUSD)
// and `CANTON_LP_REGISTRAR` issues the pool's LP token -- and a liquidity DvP
// touches both: two deposit legs on the admin's registry, the LP mint/burn leg
// on the LP registrar's. Returning one cid for every admin therefore authored
// the LP leg against the wrong registry and the ledger rejected the whole
// submission with "AllocationFactory: spec admin must match registry".
//
// It also discloses the registry contract. Registry.V2 is `observer users`
// and that list is fixed at creation, so a party outside it -- every party the
// testnet faucet hands out -- cannot see the factory it has to exercise, and
// its allocation fails with CONTRACT_NOT_FOUND. Explicit contract disclosure
// is the supported way through: attach the contract's createdEventBlob to the
// submission. A real registry serves this from its off-ledger API alongside
// factoryId and choiceContextData; here it is read straight off the ledger,
// which is the same data by a shorter path.
interface ResolvedRegistry {
  cid: string;
  disclosure: DisclosedContract[];
}

export class FixedRegistry extends RegistryClient {
  private readonly cache = new Map<string, ResolvedRegistry>();

  constructor(
    private readonly allocCid: ContractId<"AllocationFactory">,
    private readonly settleCid: ContractId<"SettlementFactory">,
    private readonly ledgerBaseUrl: string,
    private readonly ledgerToken: string,
    private readonly adminParty: string,
  ) {
    super({ baseUrl: "http://fixed-registry" });
  }

  /**
   * This admin's own Registry contract, disclosed so non-observers can exercise
   * its factories. Matched on the contract's `admin` FIELD rather than on the
   * queried party: the LP registrar is an observer on the deposit registry too,
   * so its ACS carries both and picking the first would reintroduce the bug.
   */
  private async resolve(admin: string): Promise<ResolvedRegistry> {
    const hit = this.cache.get(admin);
    if (hit) return hit;
    const hdrs = { Authorization: `Bearer ${this.ledgerToken}`, "Content-Type": "application/json" };
    const endRes = await fetch(`${this.ledgerBaseUrl}/v2/state/ledger-end`, { headers: hdrs });
    const { offset } = (await endRes.json()) as { offset: number };
    const res = await fetch(`${this.ledgerBaseUrl}/v2/state/active-contracts`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({
        verbose: false,
        activeAtOffset: offset,
        filter: { filtersByParty: { [admin]: { cumulative: [
          { identifierFilter: { TemplateFilter: { value: {
            // ACS filters take the package-NAME form.
            templateId: "#canton-dex-trading:CantonDex.Registry.V2:Registry",
            includeCreatedEventBlob: true,
          } } } },
        ] } } },
      }),
    });
    const body = (await res.json()) as Array<{
      contractEntry?: { JsActiveContract?: { createdEvent?: {
        contractId: string; templateId: string; createdEventBlob?: string;
        createArgument?: { admin?: string };
      } } };
    }>;
    const ev = body
      .map((e) => e.contractEntry?.JsActiveContract?.createdEvent)
      .find((c) => c?.createArgument?.admin === admin && c?.createdEventBlob);
    if (!ev?.createdEventBlob) {
      // Fall back to the configured cids so a deployment that cannot read the
      // blob keeps the behaviour it had before -- degraded (faucet parties will
      // fail with CONTRACT_NOT_FOUND) but not worse.
      const fallback = admin === this.adminParty ? this.allocCid : null;
      log.warn("registry contract unresolved for admin; parties outside its observer " +
        "list will not be able to allocate", { admin, fallbackCid: fallback });
      if (!fallback) {
        throw new Error(`no Registry.V2 contract found for admin ${admin}`);
      }
      const degraded = { cid: fallback, disclosure: [] as DisclosedContract[] };
      this.cache.set(admin, degraded);
      return degraded;
    }
    // The disclosed templateId must carry the resolved package id -- the
    // `#package-name` form used in the filter above is rejected here.
    const resolved: ResolvedRegistry = {
      cid: ev.contractId,
      disclosure: [{
        templateId: ev.templateId, contractId: ev.contractId, createdEventBlob: ev.createdEventBlob,
      }],
    };
    this.cache.set(admin, resolved);
    return resolved;
  }

  override async getFactories(admin: string) {
    const { cid, disclosure } = await this.resolve(admin);
    // Registry.V2 implements both factory interfaces, so one contract answers
    // for both; `settleCid` stays configurable only for the degraded path.
    return {
      allocationFactoryCid: cid as ContractId<"AllocationFactory">,
      settlementFactoryCid: (cid === this.allocCid
        ? this.settleCid
        : (cid as unknown as ContractId<"SettlementFactory">)),
      disclosure,
    };
  }
  override async getChoiceContext(admin: string): Promise<ChoiceContextRef> {
    const { disclosure } = await this.resolve(admin);
    return { context: { values: {} }, disclosure };
  }
}
