import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOLDING_V1_INTERFACE_ID,
  HOLDING_V2_INTERFACE_ID,
  resolveSpendableHoldings,
  type AcsRequest,
} from "@/wallet/holdings";
import { concreteHoldingTemplate } from "@/wallet/asset-compat";
import type { InstrumentId } from "@/types/contracts";

const OWNER = "alice::1220a";
const PKG = "#canton-dex-trading-v2";

// The seeded compat instrument (Canton Coin / Amulet) and its concrete template.
const CC: InstrumentId = {
  admin: "DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337",
  id: "Amulet",
};
const AMULET_TEMPLATE = "#splice-amulet:Splice.Amulet:Amulet";
const USDCX: InstrumentId = { admin: "usdc-admin", id: "USDCx" };

// A fake ACS transport that answers ledger-end and routes each active-contracts
// read by the single cumulative filter it carries: the HoldingV2 interface, the
// DEX Registry.V2 template, or a concrete compat template.
function makeRequest(opts: {
  interfaceResult?: unknown[];
  registryResult?: unknown[];
  concreteResult?: unknown[];
  offset?: number;
}) {
  const calls: Array<{
    method: string;
    resource: string;
    templateId?: string;
    isInterface?: boolean;
    interfaceId?: string;
  }> = [];
  const request = async (req: AcsRequest): Promise<unknown> => {
    if (req.resource === "/v2/state/ledger-end") {
      calls.push({ method: req.method, resource: req.resource });
      return { offset: opts.offset ?? 5 };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = req.body as any;
    const idf = body.filter.filtersByParty[OWNER].cumulative[0].identifierFilter;
    if (idf.InterfaceFilter) {
      calls.push({
        method: req.method,
        resource: req.resource,
        isInterface: true,
        interfaceId: idf.InterfaceFilter.value.interfaceId,
      });
      return { activeContracts: opts.interfaceResult ?? [] };
    }
    const templateId = idf.TemplateFilter.value.templateId as string;
    calls.push({ method: req.method, resource: req.resource, templateId });
    if (templateId.endsWith("CantonDex.Registry.V2:Holding")) {
      return { activeContracts: opts.registryResult ?? [] };
    }
    if (templateId === AMULET_TEMPLATE) {
      return { activeContracts: opts.concreteResult ?? [] };
    }
    return { activeContracts: [] };
  };
  return { request, calls };
}

function interfaceHolding(contractId: string, instrument: InstrumentId, amount: string) {
  return {
    contractId,
    interfaceViews: [
      {
        interfaceId: HOLDING_V2_INTERFACE_ID,
        viewValue: {
          account: { owner: OWNER, provider: null, id: "" },
          instrumentId: { admin: instrument.admin, id: instrument.id },
          amount,
          lock: null,
        },
      },
    ],
  };
}

describe("concreteHoldingTemplate", () => {
  it("maps the seeded Canton Coin instrument to the Amulet template", () => {
    expect(concreteHoldingTemplate(CC)).toBe(AMULET_TEMPLATE);
  });

  it("returns undefined for an instrument with no compat entry (USDCx)", () => {
    expect(concreteHoldingTemplate(USDCX)).toBeUndefined();
  });
});

describe("resolveSpendableHoldings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the concrete compat template for a compat instrument and returns its real cids", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // The compat (Amulet) template returns a real, package-prefixed contract id
    // in Loop's wrapped shape.
    const { request, calls } = makeRequest({
      concreteResult: [
        { template_id: AMULET_TEMPLATE, contract_id: "00ccrealcid", amount: "5.0000000000" },
      ],
    });

    const spendable = await resolveSpendableHoldings(OWNER, CC, PKG, request);

    expect(spendable).toEqual([
      {
        contractId: "00ccrealcid",
        owner: OWNER,
        admin: CC.admin,
        instrumentId: "Amulet",
        amount: 5,
        amountRaw: "5.0000000000",
        locked: false,
      },
    ]);
    // The concrete-template query fired, filtered by the compat template.
    expect(calls.some((c) => c.templateId === AMULET_TEMPLATE)).toBe(true);
    // The concrete-template probe log is emitted for the live re-test.
    expect(info).toHaveBeenCalledWith(
      "[funding] concrete-template cids",
      expect.objectContaining({ templateId: AMULET_TEMPLATE, cids: ["00ccrealcid"] }),
    );
  });

  it("reads Amulet's nested ExpiringAmount.initialAmount for the fallback amount", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { request } = makeRequest({
      concreteResult: [
        {
          contract_id: "00ccnested",
          createArgument: { amount: { initialAmount: "7.5000000000" } },
        },
      ],
    });
    const spendable = await resolveSpendableHoldings(OWNER, CC, PKG, request);
    expect(spendable).toEqual([
      {
        contractId: "00ccnested",
        owner: OWNER,
        admin: CC.admin,
        instrumentId: "Amulet",
        amount: 7.5,
        amountRaw: "7.5000000000",
        locked: false,
      },
    ]);
  });

  it("reads the concrete compat template first and skips interface discovery for a compat instrument", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { request, calls } = makeRequest({
      interfaceResult: [interfaceHolding("if-cc-1", CC, "3.0000000000")],
      concreteResult: [
        { template_id: AMULET_TEMPLATE, contract_id: "00ccrealcid", amount: "9.0000000000" },
      ],
    });

    const spendable = await resolveSpendableHoldings(OWNER, CC, PKG, request);

    // Compat instrument: the Amulet template is read first and used; the
    // interface/Registry discovery reads never fire (avoiding the 429 burst).
    expect(spendable).toEqual([
      {
        contractId: "00ccrealcid",
        owner: OWNER,
        admin: CC.admin,
        instrumentId: "Amulet",
        amount: 9,
        amountRaw: "9.0000000000",
        locked: false,
      },
    ]);
    expect(calls.some((c) => c.templateId === AMULET_TEMPLATE)).toBe(true);
    expect(calls.some((c) => c.isInterface)).toBe(false);
  });

  it("returns empty and issues NO fallback when the instrument has no compat entry (USDCx)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { request, calls } = makeRequest({ interfaceResult: [], registryResult: [] });

    const spendable = await resolveSpendableHoldings(OWNER, USDCX, PKG, request);

    expect(spendable).toEqual([]);
    // Only the discovery reads happened (1 ledger-end + interface + Registry.V2);
    // no second ledger-end and no concrete-template query.
    expect(calls.filter((c) => c.resource === "/v2/state/ledger-end")).toHaveLength(1);
    expect(calls.some((c) => c.templateId === AMULET_TEMPLATE)).toBe(false);
    expect(info).not.toHaveBeenCalledWith(
      "[funding] concrete-template acs",
      expect.anything(),
    );
  });

  it("discovers across the HoldingV2 interface, the HoldingV1 interface, and the Registry.V2 template", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { request, calls } = makeRequest({ interfaceResult: [], registryResult: [] });

    await resolveSpendableHoldings(OWNER, USDCX, PKG, request);

    const interfaceIds = calls
      .filter((c) => c.isInterface)
      .map((c) => c.interfaceId);
    expect(interfaceIds).toContain(HOLDING_V2_INTERFACE_ID);
    expect(interfaceIds).toContain(HOLDING_V1_INTERFACE_ID);
    // The DEX's own Registry.V2 template is still queried alongside the interfaces.
    expect(
      calls.some((c) => c.templateId?.endsWith("CantonDex.Registry.V2:Holding")),
    ).toBe(true);
  });
});
