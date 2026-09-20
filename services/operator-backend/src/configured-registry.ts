import { FixedRegistryClient, RegistryError } from "@canton-dex/registry-client";
import type { ChoiceArguments, FactoryChoiceContextRef, FactoryRefs, Party } from "@canton-dex/registry-client";
import { mergeDisclosures } from "./ledger/disclosure.js";
import type { JsonApiLedger } from "./ledger/json-api.js";

export class ConfiguredRegistry extends FixedRegistryClient {
  constructor(
    factoriesByAdmin: ReadonlyMap<Party, FactoryRefs>,
    private readonly ledger: Pick<JsonApiLedger, "discloseContracts">,
  ) {
    super((admin) => {
      const factories = factoriesByAdmin.get(admin);
      if (!factories) {
        throw new RegistryError("factory-stale", `no configured factory mapping for admin=${admin}`, false);
      }
      return factories;
    });
  }

  override async getAllocationFactory(admin: Party, args: ChoiceArguments): Promise<FactoryChoiceContextRef> {
    return this.withDisclosure(admin, await super.getAllocationFactory(admin, args));
  }

  override async getSettlementFactory(admin: Party, args: ChoiceArguments): Promise<FactoryChoiceContextRef> {
    return this.withDisclosure(admin, await super.getSettlementFactory(admin, args));
  }

  private async withDisclosure(admin: Party, context: FactoryChoiceContextRef): Promise<FactoryChoiceContextRef> {
    const disclosure = await this.ledger.discloseContracts({
      templateId: "CantonDex.Registry.V2:Registry",
      observingParty: admin,
    }, [context.factoryCid]);
    return { ...context, disclosure: mergeDisclosures(context.disclosure, disclosure) };
  }
}
