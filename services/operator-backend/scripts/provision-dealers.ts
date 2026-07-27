// Provision the demo dealer parties the testnet RFQ route quotes from.
//
// WHY THIS IS A SCRIPT AND NOT A ROUTE. A dealer is not a tester: it is
// deployment state. It has to exist before any RFQ can be composed, it needs
// inventory on BOTH sides of every pair it quotes, and it has to be registered
// in the operator's own dealers table -- which is the table the RFQ route reads
// its whitelist and its tiers from. None of that is something an anonymous
// caller may trigger, so it lives here, run once by the operator, rather than
// behind an endpoint.
//
// WHY BOTH SIDES. On an `RFQ_Buy` the Daml puts the DEALER on the sender side
// of the BASE leg (Rfq.daml, `legs` under RFQ_Buy) and the trader on the quote
// leg; `RFQ_Sell` is the mirror. A dealer stocked only with the quote asset
// therefore quotes happily and then fails at `AllocationFactory_Allocate` with
// "insufficient holdings" -- AFTER `Rfq_Accept` has already consumed the Rfq
// and every quote. That choice is consuming and there is no unwind, so the
// trader's RFQ is simply gone. Inventory is the thing that prevents it.
//
// The parties are allocated through the SAME provisioner the faucet uses, with
// the same `dex-tester-` hint prefix. That is deliberate, not laziness: the
// accept flow relays each counterparty's `AllocationFactory_Allocate` through
// the public relay, whose eligibility check (`assertFaucetParty`) accepts only
// that prefix. A dealer allocated under any other hint would quote fine and
// then be unable to author its own side of the settlement.
//
// Re-runnable. Existing dealers are reused from the operator's table and their
// balances are TOPPED UP to the target rather than minted again, so running it
// twice does not allocate a second pair of parties or double the supply.
//
// Usage, on the deployment host:
//   sudo bash -c 'set -a; . /etc/canton-dex/testnet.env; set +a; \
//     cd /opt/canton-dex/repo/services/operator-backend && \
//     node --import tsx scripts/provision-dealers.ts'
//
// It lives inside the operator-backend workspace, not the repo-root scripts/
// directory, because it imports the backend's own modules -- running it from
// the root resolves @canton-dex/* against the wrong node_modules.

import { randomUUID } from "node:crypto";

import { JsonApiLedger } from "../src/ledger/json-api.js";
import { JsonApiPartyProvisioner } from "../src/testnet-onboarding/index.js";
import {
  RegistryMinter,
  REGISTRY_HOLDING_TEMPLATE_ID,
} from "../src/testnet-onboarding/registry-mint.js";
import * as dec from "../src/pool/decimal.js";
import type { RegistryHolding } from "../src/testnet-onboarding/swap.js";
import type { Party } from "../src/types.js";

const API = process.env.DEX_API ?? "http://127.0.0.1:3400";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}

const LEDGER_URL = required("CANTON_LEDGER_URL");
const LEDGER_TOKEN = required("CANTON_LEDGER_TOKEN");
const ADMIN = required("CANTON_ADMIN") as Party;
const USER_ID = process.env.CANTON_USER_ID ?? "ledger-api-user";
const ADMIN_TOKEN = required("OPERATOR_ADMIN_TOKEN");

/**
 * The dealers this deployment demos with. One trusted, one merely whitelisted,
 * so the ranking policy's first key (tier) actually separates the book -- with
 * two same-tier dealers the demo would rank on expiry alone and look arbitrary.
 */
const DEALERS = [
  { label: "northwind", name: "Northwind Markets", trusted: true },
  { label: "harbourline", name: "Harbourline Capital", trusted: false },
] as const;

/**
 * Target inventory per dealer, per instrument. Sized off the live pool mid
 * (~94k dUSD/dBTC): enough dBTC to fill a few hundred demo-sized RFQs and
 * enough dUSD to take the other side of the same number of sells.
 */
const INVENTORY: Array<{ instrumentId: string; target: string }> = [
  { instrumentId: "dBTC", target: "5.0" },
  { instrumentId: "dUSD", target: "500000.0" },
];

interface DealerRow {
  party: string;
  name: string;
  trusted: boolean;
  whitelisted: boolean;
}

async function api<T>(
  path: string,
  init?: { method: string; body?: unknown; admin?: boolean },
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(init?.admin ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function main(): Promise<void> {
  const ledger = new JsonApiLedger({
    baseUrl: LEDGER_URL,
    token: LEDGER_TOKEN,
    applicationId: USER_ID,
    templateIdPrefix: process.env.CANTON_DEX_PACKAGE_ID,
    synchronizerId: process.env.CANTON_SYNCHRONIZER,
  });
  const provisioner = new JsonApiPartyProvisioner({
    baseUrl: LEDGER_URL,
    token: LEDGER_TOKEN,
    // Same reason the faucet passes it: Registry_Mint is `controller admin,
    // owner`, so the backend's own ledger user needs CanActAs on the party it
    // is about to mint to -- and, later, on the dealer it posts quotes as.
    operatorUserId: USER_ID,
  });
  const minter = new RegistryMinter({ ledger, admin: ADMIN });

  const existing = await api<DealerRow[]>("/v1/dealers");
  console.log(`dealers table: ${existing.length} row(s)`);

  for (const spec of DEALERS) {
    // Match on the hint, not the name: the name is operator-editable and the
    // party id is the thing that has to stay stable.
    const found = existing.find((d) =>
      d.party.split("::")[0]?.includes(`-${spec.label}-`),
    );
    const party =
      found?.party ??
      (await provisioner.provision(`dex-tester-dealer-${spec.label}-${randomUUID()}`));
    console.log(`\n${spec.name}`);
    console.log(`  party ${party}`);
    console.log(`  ${found ? "reused from the dealers table" : "newly allocated"}`);

    const holdings = await ledger.query<RegistryHolding>({
      templateId: REGISTRY_HOLDING_TEMPLATE_ID,
      observingParty: party,
    });
    for (const { instrumentId, target } of INVENTORY) {
      const have = holdings
        .filter(
          (h) =>
            h.owner === party &&
            h.admin === ADMIN &&
            h.instrumentId === instrumentId &&
            h.locked !== true,
        )
        .reduce((sum, h) => sum + dec.parseDecimal(h.amount), 0n);
      const want = dec.parseDecimal(target);
      if (have >= want) {
        console.log(
          `  ${instrumentId}: ${dec.formatDecimal(have)} -- already at target`,
        );
        continue;
      }
      const top = dec.formatDecimal(want - have);
      await minter.mint(party as Party, instrumentId, top);
      console.log(
        `  ${instrumentId}: ${dec.formatDecimal(have)} -> ${target} (minted ${top})`,
      );
    }

    const row = await api<DealerRow>("/v1/admin/dealers", {
      method: "PUT",
      admin: true,
      body: {
        party,
        name: spec.name,
        trusted: spec.trusted,
        whitelisted: true,
      },
    });
    console.log(
      `  registered: trusted=${row.trusted} whitelisted=${row.whitelisted}`,
    );
  }

  const after = await api<DealerRow[]>("/v1/dealers");
  console.log(`\ndealers now: ${after.length}`);
  for (const d of after) {
    console.log(`  ${d.name}  trusted=${d.trusted}  ${d.party.split("::")[0]}`);
  }
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
