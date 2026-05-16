# Stable Pool — Canton-Dex reuse proof point

This is a separate Daml project that **consumes the
`canton-dex-pr5333` DAR as a data-dependency** and builds a different
DEX surface — a StableSwap pool — on top.

It's the reference's reuse demonstration: an external builder can
take the public DAR, write Daml against it, and ship a meaningfully
different DEX without forking the core templates.

## What it shows

1. **Curve-agnostic substrate.** The base reference's slice-local
   `Pool` template is constant-product (`xy=k`). This example shows
   that the *V2 standard surface* the pool stands on (allocations,
   holdings, transfer instructions) doesn't care about the curve.
   Swap a different invariant in and the rest of the stack works.

2. **DAR consumption.** `daml.yaml` lists
   `canton-dex-pr5333-0.0.7.dar` as a data-dependency. The example
   compiles against that binary artefact; it does not edit any of
   the base templates.

3. **LP & router compatibility.** The `StablePool` template has the
   same head fields as `Pool` (operator, lpRegistrar, instrument
   ids, fee, reserves, totalLpSupply), so a multi-curve operator
   could route to either type and the dApp can render them the same
   way.

## What it does NOT show

To keep the example focused on the curve math, this version only
implements `StablePool_ComputeSwapOut` (read-only). The full
allocation-adjust + settle wiring is identical to the base
reference's `Pool_Swap` and is omitted for brevity. A production
fork would copy that wiring (10–15 lines) into `StablePool_Swap`.

## Build & test

From the repo root:

```bash
# Make sure canton-dex-pr5333-0.0.7.dar exists first
bash scripts/build-pr5333-surface.sh

# Then build + test the example
cd examples/stable-pool
daml build
daml test
```

Expected: 3 tests pass.

## File layout

```
examples/stable-pool/
├── daml.yaml                                 # data-deps the published DAR + V2 standard
├── CantonDex/
│   └── StablePool/
│       └── StableSwap.daml                   # new template + curve math
├── Tests/
│   └── StableSwapTests.daml                  # 3 tests
└── README.md
```

## When you'd actually use this

For pegged-asset pairs:

- USDC/USDT, USDC/DAI (stablecoin swaps)
- stETH/ETH, rETH/ETH (LST / underlying)
- bridged-X / canonical-X

The amplification parameter `A` tunes the trade-off: high A = tight
pricing near peg, harsher slippage when the pool de-pegs; low A =
behaves like xy=k.

## Curve math reference

Solves the StableSwap invariant for n=2:

    A * 4 * (x + y) + D = 4 * A * D + D^3 / (4 * x * y)

Newton iteration solves for D, then a second Newton solves for the
output `y` given a new `x = oldX + dx`. Both iterations cap at 32
steps with a 1e-6 convergence threshold.

For the original paper see Curve Finance's whitepaper (the
specific math here is a 2-asset specialisation).
