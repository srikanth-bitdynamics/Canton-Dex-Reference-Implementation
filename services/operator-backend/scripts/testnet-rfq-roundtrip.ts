// Prove the RFQ round trip against the live deployment, through the PUBLIC
// routes only.
//
// WHY THIS EXISTS. The RFQ flow is the last thing the DEX advertises that had
// never executed on a real participant, and unit tests cannot catch what breaks
// it: the mock ledger models neither visibility nor Daml decoding, so a wrong
// wire shape (the settle payload, the Account record, the AllocationSpecification
// -- all three shipped and all three were caught only here) passes the suite and
// fails the ledger. This runs the whole thing for real.
//
// It uses NO operator token and NO admin token. Every call is one an anonymous
// browser could make: the faucet, POST /v1/testnet/rfq, GET /v1/rfq, POST
// /v1/testnet/rfq/accept, GET /v1/holdings. If this passes, the dApp path works.
//
// Read-only against everything except the one faucet party it creates (or
// reuses) and the one trade it settles.
//
// Usage, on the deployment host:
//   sudo bash -c 'set -a; . /etc/canton-dex/testnet.env; set +a; \
//     cd /opt/canton-dex/repo/services/operator-backend && \
//     node --import tsx scripts/testnet-rfq-roundtrip.ts'
//
//   RFQ_TRADER=<party>  reuse a party from an earlier run (the faucet has a
//                       per-IP daily cap, and a probe that burns a slot per run
//                       stops being runnable long before it stops being useful)
//   RFQ_SIDE=RFQ_Sell   flip the direction; the dealer then delivers quote and
//                       the trader delivers base, which is the case a
//                       quote-only dealer used to fail
//   RFQ_SIZE=0.01       base quantity

const API = process.env.DEX_API ?? "http://127.0.0.1:3400";
const SIDE = (process.env.RFQ_SIDE ?? "RFQ_Buy") as "RFQ_Buy" | "RFQ_Sell";
const SIZE = process.env.RFQ_SIZE ?? "0.01";
const PAIR = process.env.RFQ_PAIR ?? "dBTC/dUSD";

const ok = (s: string) => console.log(`  ✓ ${s}`);
const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  process.stdout.write(`${label}\n`);
  try {
    const r = await run();
    ok(label);
    return r;
  } catch (e) {
    console.error(`  ✗ ${label}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    // Deliberately no Authorization header: the whole point is that these
    // routes work for a caller who has none.
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

interface Holding {
  instrumentId: string;
  amount: string;
  locked?: boolean;
}

/** Unlocked balance per instrument, plus how many holdings are locked. */
async function balances(
  party: string,
): Promise<{ free: Record<string, number>; locked: number }> {
  const holdings = await api<Holding[]>(
    `/v1/holdings?owner=${encodeURIComponent(party)}`,
  );
  const free: Record<string, number> = {};
  for (const h of holdings) {
    if (h.locked) continue;
    free[h.instrumentId] = (free[h.instrumentId] ?? 0) + parseFloat(h.amount);
  }
  return { free, locked: holdings.filter((h) => h.locked).length };
}

const label = (p: string) => p.split("::")[0]!;
const show = (b: { free: Record<string, number>; locked: number }) =>
  `${Object.entries(b.free)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")}  (locked: ${b.locked})`;

interface Dealer {
  party: string;
  name: string;
  trusted: boolean;
  whitelisted: boolean;
}

interface RfqReceipt {
  rfqId: string;
  rfqCid: string;
  pair: string;
  expiresAt: string;
  quotes: Array<{ dealer: string; quoteCid: string; price: string; tier: string }>;
}

async function main(): Promise<void> {
  const dealers = await step("read /v1/dealers", async () => {
    const rows = await api<Dealer[]>("/v1/dealers");
    if (rows.length === 0) {
      throw new Error("no dealers registered; run scripts/provision-dealers.ts");
    }
    for (const d of rows) {
      const b = await balances(d.party);
      console.log(`    ${d.name} trusted=${d.trusted}: ${show(b)}`);
    }
    return rows;
  });

  const trader = await step("obtain a faucet party", async () => {
    const reuse = process.env.RFQ_TRADER;
    if (reuse) {
      console.log("    reusing RFQ_TRADER");
      return reuse;
    }
    const p = await api<{ partyId: string }>("/v1/testnet/party", {});
    return p.partyId;
  });
  console.log(`    trader ${label(trader)}`);

  const before = new Map<string, Awaited<ReturnType<typeof balances>>>();
  for (const p of [trader, ...dealers.map((d) => d.party)]) {
    before.set(p, await balances(p));
  }
  console.log(`    trader before: ${show(before.get(trader)!)}`);

  const rfq = await step(`POST /v1/testnet/rfq (${SIDE} ${SIZE} ${PAIR})`, async () => {
    const r = await api<RfqReceipt>("/v1/testnet/rfq", {
      party: trader,
      pair: PAIR,
      side: SIDE,
      size: SIZE,
      expiryMinutes: 60,
    });
    console.log(`    rfqId ${r.rfqId}  pair ${r.pair}  expires ${r.expiresAt}`);
    for (const q of r.quotes) {
      console.log(`    ${label(q.dealer)}  ${q.price}  ${q.tier}`);
    }
    if (r.quotes.length < 2) {
      throw new Error(`expected a quote per dealer, got ${r.quotes.length}`);
    }
    return r;
  });

  await step("GET /v1/rfq shows it with its quotes", async () => {
    const view = await api<{
      rfqs: Array<{ contractId: string; rfqId: string }>;
      quotes: Array<{ rfqId: string }>;
    }>(`/v1/rfq?owner=${encodeURIComponent(trader)}`);
    if (!view.rfqs.some((r) => r.contractId === rfq.rfqCid)) {
      throw new Error("the RFQ is not in the operator's read model");
    }
    const mine = view.quotes.filter((q) => q.rfqId === rfq.rfqId);
    if (mine.length !== rfq.quotes.length) {
      throw new Error(
        `expected ${rfq.quotes.length} quotes on the RFQ, saw ${mine.length}`,
      );
    }
  });

  // Take the trusted dealer's quote: it is rank 1 under the policy (tier is the
  // first sort key), so the receipt's acceptedRank should come back as 1.
  const chosen =
    rfq.quotes.find((q) => q.tier === "TierTrusted") ?? rfq.quotes[0]!;
  console.log(`\n  accepting ${label(chosen.dealer)} at ${chosen.price}`);

  const accepted = await step("POST /v1/testnet/rfq/accept", async () => {
    const r = await api<{
      tradeCid: string;
      acceptedDealer: string;
      acceptedRank: number;
      consideredCount: number;
      updateId: string;
    }>("/v1/testnet/rfq/accept", {
      party: trader,
      rfqCid: rfq.rfqCid,
      acceptedQuoteCid: chosen.quoteCid,
    });
    console.log(
      `    trade ${r.tradeCid.slice(0, 16)}...  rank ${r.acceptedRank}/${r.consideredCount}`,
    );
    return r;
  });

  await step("confirm both legs moved and nothing is locked", async () => {
    const size = parseFloat(SIZE);
    const notional = size * parseFloat(chosen.price);
    const [base, quote] = PAIR.split("/") as [string, string];

    // On a Buy the trader receives base and pays quote; a Sell is the mirror.
    const expect: Array<{
      party: string;
      instrument: string;
      delta: number;
      what: string;
    }> = [
      {
        party: trader,
        instrument: base,
        delta: SIDE === "RFQ_Buy" ? size : -size,
        what: "trader base",
      },
      {
        party: trader,
        instrument: quote,
        delta: SIDE === "RFQ_Buy" ? -notional : notional,
        what: "trader quote",
      },
      {
        party: accepted.acceptedDealer,
        instrument: base,
        delta: SIDE === "RFQ_Buy" ? -size : size,
        what: "dealer base",
      },
      {
        party: accepted.acceptedDealer,
        instrument: quote,
        delta: SIDE === "RFQ_Buy" ? notional : -notional,
        what: "dealer quote",
      },
    ];

    const after = new Map<string, Awaited<ReturnType<typeof balances>>>();
    for (const p of [trader, ...dealers.map((d) => d.party)]) {
      after.set(p, await balances(p));
    }
    for (const [p, b] of after) {
      console.log(`    ${label(p)}: ${show(b)}`);
    }

    for (const e of expect) {
      const from = before.get(e.party)!.free[e.instrument] ?? 0;
      const to = after.get(e.party)!.free[e.instrument] ?? 0;
      const moved = to - from;
      // Tolerance is one unit of the 10dp Daml scale, scaled by the notional:
      // the on-ledger multiply is exact but the check here goes through
      // IEEE-754.
      const tol = Math.max(1e-8, Math.abs(e.delta) * 1e-9);
      if (Math.abs(moved - e.delta) > tol) {
        throw new Error(
          `${e.what}: expected ${e.delta} ${e.instrument}, saw ${moved}`,
        );
      }
      console.log(`    ${e.what}: ${moved > 0 ? "+" : ""}${moved} ${e.instrument}`);
    }

    for (const [p, b] of after) {
      if (b.locked > 0) {
        throw new Error(`${label(p)} still has ${b.locked} LOCKED holding(s)`);
      }
    }
  });

  console.log(`\nRFQ settled on-ledger. Nothing left locked.`);
  console.log(`Reuse this party with RFQ_TRADER=${trader}`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
