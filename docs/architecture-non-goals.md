# Non-goals: what this reference deliberately does NOT include

A reference implementation is most useful when its scope is explicit.
Below is what's intentionally **out of scope** for Canton-Dex, and
why. Items here are not "TODO"; they're calls we made about the
shape of the reference. Forks are encouraged to address them
differently.

## Settlement & matching

### Central limit-order-book matcher (CLOB)

Not included. The reference exposes the primitives (`Order`,
`OrderMatchExecution`, `Order_RecordPartialFill`, `Allocation_Adjust`),
but the off-chain matching engine (price-time priority queue, order
book persistence, fairness guarantees) is operator code.

Why: a production CLOB is a substantial engineering effort
(microsecond latency, deterministic ordering, audit trail) whose
correctness is independent of the V2 standard. Building it would
crowd out the reference value of the underlying templates. If you
need a CLOB, fork and add it; the on-chain primitives won't fight
you.

### Cross-venue routing / aggregation

**Not included.** The dApp talks to one operator-backend talking to
one venue. There's no router that splits an order across multiple
Canton DEXes.

Why: cross-venue is a layer above the reference. The price
oracles, settlement coordination, and trust assumptions are not
generic.

### MEV protection / sealed-bid auctions

**Not included.** Order arrival and visibility follow standard
Canton observation. We have neither a commit-reveal scheme nor a
batch auction.

Why: Canton's deterministic transaction ordering removes most
front-running classes that affect public-chain DEXes. The remaining
MEV surface (e.g., operator-driven ordering bias) is a *governance*
problem, not a primitive problem.

## Pricing

### Oracle integration

**Not included.** No on-chain price feed. The Pool's mark price is
strictly `xy=k`-derived; RFQs are dealer-quoted; orders are
limit-priced.

Why: we evaluated and concluded oracles aren't *needed* for the
pool/RFQ surfaces. They become useful for: (a) UI "fair value"
badges, (b) risk circuit breakers (pause pool on N% divergence), (c)
oracle-weighted RFQ ranking. None of those exist in the reference.
Building them is straightforward and is left to forks. Design notes
in `docs/pricing-sources.md`.

### Concentrated liquidity / tick-based pools

**Not included.** The pool is full-range constant-product.

Why: tick-based pools (Uniswap V3-style) involve a different
slice model and reserve representation. The slice-local design we
ship works for full-range; adapting it for ticks is a re-design,
not an extension.

### Multi-hop swaps

**Not included.** `Pool_Swap` operates on a single pool. No
A → B → C routing.

Why: composable, but adds complexity to fee computation, slippage
bounds, and atomic settlement. Stick to single-hop in the reference.

## Asset surface

### Native token / gas abstraction

**Not included.** Canton has no native gas token; traffic costs are
denominated in Amulet, not in the user's traded asset. The
reference passes that pricing model through transparently. See
`docs/traffic-cost-model.md`.

Why: pretending otherwise would lie about Canton's economics.

### Bridges / cross-chain assets

**Not included.** Every instrument is Canton-native.

Why: bridging is a security domain unto itself. Out of scope.

### Rebasing / stETH-style elastic supply

**Not included.** V2 holdings have fixed `amount`; rebases would
require ACS rewrites or wrapper indirection.

Why: V2 standard doesn't natively support it. A wrapper pattern
is the canonical workaround; build it in your fork.

## Compliance / governance

### KYC / AML / sanctions screening

**Not included.** Anyone with a Canton party can trade.

Why: jurisdictional and operator-specific. The `Credential`
template in `Registry.V2` is the building block; wire it to your
KYC provider in your fork.

### Pause / kill switch

**Partially included.** `DexPair.active = false` halts a pair;
`Pool_Pause` halts a pool. There is **no** global emergency stop.

Why: per-pair / per-pool granularity matches typical operator
incident response. A global stop is one config flag away in your
fork.

### Upgradable contracts (proxies, governance votes)

**Not included.** Daml smart-upgrade replaces this: contracts are
upgraded by deploying a new package version with binary-compatible
templates, and the participant transparently migrates contracts.

Why: this is the canonical Canton story; proxies are an EVM
workaround for the lack of native upgrade support.

## Operator

### Multi-operator / decentralised venue

**Not included.** The reference assumes one operator party. There's
no consortium voting on parameters, no operator rotation, no
trust-minimised admin.

Why: multi-operator is a governance-design question. The
contract surface doesn't preclude it (operator-signed templates can
be re-signed by a delegate), but the orchestration is fork-specific.

### Production-grade rate limiting / DDoS protection

**Not included.** The HTTP layer is a thin shim; rate limiting and
authentication are operator-deployment concerns (reverse proxy,
WAF, OAuth).

### Operator key custody / HSM integration

**Not included.** The operator backend reads the JWT from the
`CANTON_LEDGER_TOKEN` env var. Production should mount this from a
secrets manager (Vault, AWS Secrets Manager, HSM-backed). The
reference doesn't ship that wiring.

## UI

### Production design system

**Not included.** The UI is functional, not polished. No design
system, no accessibility audit, no animation polish, no mobile.

Why: the value of the reference is the *data flow* and the
*wallet boundary*, not the visuals. A production fork should
re-style.

### Real-time WebSocket fan-out

**Not included.** UI polls REST endpoints; trade feed updates every
~5s.

Why: WebSocket fan-out is a few hours of work atop the indexer
(pub/sub off the polling loop) but adds operational complexity. We
chose poll for the reference and document the upgrade path in
`operator-notes.md`.

## Testing

### Production-grade integration test matrix

**Not included.** We have 26 Daml-script tests + a handful of
testnet harness scripts. There is no continuous-test pipeline
running against the live testnet on every commit; no chaos /
fuzz testing; no SLI/SLO definitions.

Why: those are deployment-specific concerns. The 26-test suite
verifies the contract surface; the harness scripts demonstrate the
testnet path.

---

If you think something here should not be a non-goal, open a
discussion. The deliberate-call list is meant to be re-litigated,
not handed down.
