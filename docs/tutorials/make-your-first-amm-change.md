# Tutorial: make your first AMM code change

This is Step 8 of the
[canonical newcomer learning path](../README.md#canonical-newcomer-learning-path).
Complete the workflow-design step first. Here you will make one small,
behavior-preserving Daml refactor: give the swap-fee calculation a name, prove
the new helper with a focused test, and then check every layer that could be
affected.

You will edit two files in your own checkout:

- `trading/CantonDex/Dex/PoolModel.daml`, which owns the AMM arithmetic; and
- `trading-tests/CantonDex/Tests/PoolRoundingTests.daml`, which proves the
  arithmetic's conservative rounding.

The finished change does **not** alter the formula, template fields, choices,
HTTP API, or UI. That makes it a useful first contribution: the fail/pass loop
is real, while the expected behavior remains stable.

## Before you start

From the repository root, confirm that the unmodified Daml surface is green:

```bash
bash scripts/run-local-daml-tests.sh
```

All Daml Script tests should report `ok`, and the command should exit with
status 0. If the command cannot find Java, DPM, or SDK 3.5.2, return to
[Getting started — prerequisites](../getting-started.md#prerequisites).

Keep the repository root as the starting directory for every command below.

## 1. Write the focused proof first

Open
[`trading-tests/CantonDex/Tests/PoolRoundingTests.daml`](../../trading-tests/CantonDex/Tests/PoolRoundingTests.daml)
and find this existing declaration:

```daml
testSwapOutputRoundsDownToKeepConstantProduct : Script ()
testSwapOutputRoundsDownToKeepConstantProduct = do
```

Immediately after the `= do` line, add these two assertions:

```daml
  PM.amountAfterSwapFee 30 1000.0 === 997.0
  PM.amountAfterSwapFee 25 1000.0 === 997.5
```

They state the rule in basis points: a 30 bps fee leaves `997.0` of a
`1000.0` input, and a 25 bps fee leaves `997.5`. The `PM` alias is already
imported at the top of the test file.

Run only that script:

```bash
(cd trading-tests && dpm test -p testSwapOutputRoundsDownToKeepConstantProduct)
```

### Expected failure

The command should exit nonzero because `amountAfterSwapFee` does not exist
yet. Depending on the SDK's diagnostic wording, the error will say that
`PM.amountAfterSwapFee` is unknown, not in scope, or not exported. This failure
is the red half of the red/green loop. If the test passes at this point, check
that you saved the file and ran the command from this checkout.

## 2. Extract the fee calculation

Open
[`trading/CantonDex/Dex/PoolModel.daml`](../../trading/CantonDex/Dex/PoolModel.daml).
Find `floorDiv`, then add this helper immediately below it:

```daml
-- | Input remaining after the pool fee, rounded down so the pool never
-- pays out from value it did not receive.
amountAfterSwapFee : Int -> Decimal -> Decimal
amountAfterSwapFee feeBps inputAmount =
  floorDiv
    (floorMul inputAmount (intToDecimal (10000 - feeBps)))
    10000.0
```

Next, find `constantProductOut` and replace only its definition with:

```daml
constantProductOut : Decimal -> Decimal -> Int -> Decimal -> Decimal
constantProductOut reserveIn reserveOut feeBps inputAmount =
  let amountInAfterFee = amountAfterSwapFee feeBps inputAmount
  in floorDiv (floorMul amountInAfterFee reserveOut)
       (reserveIn + amountInAfterFee)
```

The old inline expression and the new helper call are mathematically
identical. `floorMul` and `floorDiv` still round in the pool's favor at the
same points.

## 3. Build, then make the focused proof green

Build the trading DAR before compiling its test package:

```bash
bash scripts/build-trading-surface.sh
(cd trading-tests && dpm test -p testSwapOutputRoundsDownToKeepConstantProduct)
```

The focused command should now exit 0 and report the named script as `ok`.
If it still reports the missing helper, confirm that the helper is at module
scope rather than nested inside `floorDiv`.

## 4. Check which layers the change affects

Use this table before expanding the change:

| Layer | Impact of this tutorial's edit | Why |
|---|---|---|
| Daml implementation | **Changed** | `constantProductOut` now calls a named helper. |
| Ledger schema and choices | **Unchanged** | No template, record, choice argument, or result type changed. |
| Settlement behavior | **Unchanged by design** | The same fee and rounding expression runs before the same output calculation. |
| Operator backend | **No edit required** | Its public API and expected quote shape did not change. |
| React dApp / wallet handoff | **No edit required** | No request, response, or wallet-intent field changed. |

This is impact analysis, not permission to ignore other layers for a real math
change. If you later change the formula or rounding, inspect and update these
consumers together:

- `services/operator-backend/src/pool/index.ts` for backend quote math;
- `services/operator-backend/src/dev-server.ts` for preview behavior;
- `scripts/live-amm-roundtrip.ts` for the independent live-proof expectation;
- the related backend tests and dApp tests for displayed quotes and limits.

The UI can display a fee and proposed quote, but it does not authorize final
settlement. The Daml choice must always recompute and validate executable
amounts from the bound ledger state.

## 5. Run the full local checks

Now prove that the refactor did not disturb another workflow:

```bash
bash scripts/run-local-daml-tests.sh
(cd services/operator-backend && npm run typecheck && npm test)
(cd app/web && npm test && npm run build)
```

Expected results:

- every Daml Script test reports `ok` and the script exits 0;
- backend type-checking exits cleanly and TAP ends with `# fail 0`; and
- Vitest reports all dApp tests passed, then Vite writes `app/web/dist/`.

Run `npm ci` once in `services/operator-backend` and `app/web` if their
dependencies are not installed.

## 6. Prove the DAR on a real throwaway Canton process

Run the repository's portable live-ledger proof:

```bash
bash scripts/run-dpm-sandbox-proof.sh
```

Near the end, expect:

```text
==> Running the live-Canton DvP proof
==> PASS: portable live-Canton proof completed
    The throwaway sandbox is now stopping; no persistent ledger state remains.
```

This proves package upload and add → quote-bound swap → partial-remove value
movement through the JSON Ledger API on a real Canton process. It still does
not prove browser, external-wallet, or operator-backend HTTP integration. Those
boundaries require the separately configured environments described in
[Getting started](../getting-started.md) and the
[testing reference](../reference/testing.md).

## 7. Review the change

Check whitespace and inspect only the intended diff:

```bash
git diff --check
git diff -- \
  trading/CantonDex/Dex/PoolModel.daml \
  trading-tests/CantonDex/Tests/PoolRoundingTests.daml
```

You are finished when:

- the focused proof failed before the helper existed and passed afterward;
- the complete Daml, backend, and dApp checks pass;
- the live sandbox proof prints its `PASS` line;
- the diff contains one helper, one call-site refactor, and two assertions; and
- you can explain why no backend or UI source edit was needed.

Continue to Step 9, the [Builder guide](../guides/builder-guide.md), to plan a
behavior-changing extension and identify every affected boundary before you
edit it.
