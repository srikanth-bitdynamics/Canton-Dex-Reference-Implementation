# Local Canton from a clean clone

This repository does **not** require Canton DevKit. It supports two local
network experiences with different boundaries:

| Path | Additional prerequisite | What it proves | What it does not prove |
|---|---|---|---|
| **DPM sandbox proof (default)** | none beyond the pinned DPM SDK | Real Canton process, JSON Ledger API, current DEX DAR with its Token Standard closure, distinct LP/swapper parties, and add → swap → remove DvP settlement | Splice wallet/scan UIs, multi-participant topology, browser/backend HTTP, external wallet |
| **DevKit LocalNet (optional)** | a separately distributed `canton-devkit` executable and Docker | Full persistent Splice LocalNet services plus the same DEX live driver | Production topology/security and an automated browser-wallet test |

The DEX application and its DARs have no runtime dependency on DevKit. The
optional script is a lifecycle and credential adapter: it starts or reuses the
named developer network, but the separately distributed `canton-devkit`
executable must already be installed.

## Prerequisites

Both paths need:

- Node.js 24 or newer
- Java 17
- DPM and the SDK version pinned in `trading/daml.yaml`
- `curl`, Bash, and npm

Verify them from the repository root:

```bash
node --version
java -version
dpm --version
curl --version
```

The default proof does not need Docker. The optional DevKit path does.

## Path A: portable DPM sandbox proof

Run:

```bash
bash scripts/run-dpm-sandbox-proof.sh
```

The script performs these visible phases:

1. Installs SDK 3.5.2 idempotently and builds `canton-dex-trading-v2`.
2. Reserves all six Canton ports, releases them together, and starts the SDK's
   `dpm sandbox` immediately on those concrete loopback ports.
3. Waits for `/v2/state/ledger-end`; readiness is proven, not assumed.
4. Creates one unrestricted user only inside this unauthenticated throwaway
   sandbox. The bootstrap party is operator/admin/LP registrar; the script then
   allocates a distinct LP/trader party and a distinct swapper party.
5. Uploads exactly the newly built trading DAR selected by
   `trading/daml.yaml`; the DAR embeds its Token Standard dependency closure.
6. Runs the direct JSON-API driver through add liquidity, a quote-bound swap,
   and redemption of half the LP position.
7. Checks exact balances and reserves, active-slice sums after every phase, LP
   holding/supply/policy agreement, `x*y` nondecrease, reserve-per-LP, and
   aggregate base/quote value conservation.
8. Stops Canton and removes its temporary state after a pass.

The final checkpoint is:

```text
==> PASS: portable live-Canton proof completed
    The throwaway sandbox is now stopping; no persistent ledger state remains.
```

If a phase fails, the script preserves its temporary directory and prints the
path containing `canton.log` and `canton.stdout.log`. It never prints a JWT—the
DPM sandbox has authentication disabled and the placeholder bearer value is not
a credential.

### Party and credential model

The proof needs real counterparties: the LP/trader, swapper, and operator are
three distinct Canton parties. This prevents a deposit or swap from degenerating
into a transfer from a party to itself. The operator party also acts as asset
admin and LP registrar for this self-contained fixture, however, and the single
sandbox user has `CanExecuteAsAnyParty`, `CanReadAsAnyParty`, and
`ParticipantAdmin` rights. That is deliberately convenient throwaway setup,
not a production authorization model.

Focused Daml tests cover finer-grained controller failures with separate
parties. A deployment sign-off must additionally prove its actual users, JWTs,
and least-privilege rights with the
[Validator Test Plan](validator-test-plan.md).

### What this proof intentionally bypasses

The driver submits JSON Ledger API commands directly. It does not start:

- the operator HTTP server;
- the React dApp;
- a wallet extension or PartyLayer;
- a multi-participant Splice network.

Passing it is live-ledger integration evidence, not browser full-stack E2E
evidence. The [testing boundary matrix](../reference/testing.md)
is the authoritative scope definition.

## Path B: optional persistent DevKit LocalNet

Use this only when your development environment already distributes
`canton-devkit`:

```bash
command -v canton-devkit
canton-devkit version
```

If the first command prints nothing, skip this path. The repository does not
silently download or install an unpinned network manager. Use Path A, an
organization-approved DevKit installation, or the official Canton Network
Quickstart selected by your deployment team.

Docker must be running. Then execute:

```bash
bash scripts/run-localnet-roundtrip.sh canton-dex
```

The integration wrapper:

1. runs `canton-devkit localnet doctor`;
2. starts or reuses the named `0.6.12` instance;
3. imports the app-provider endpoint and JWT inside the process without
   printing the token;
4. discovers the ledger user's primary party;
5. builds/uploads the DEX package closure; and
6. allocates an LP/trader and swapper through the standard JSON Ledger API when
   explicit party overrides are absent; and
7. executes the same add → quote-bound swap → half-LP-remove driver.

Unlike Path A, it deliberately leaves the instance running so you can inspect
contracts and transactions:

```bash
canton-devkit localnet status --name canton-dex
canton-devkit localnet contracts --help
canton-devkit localnet tx --help
```

Stop containers while preserving the instance volumes:

```bash
canton-devkit localnet down --name canton-dex
```

The following is destructive and deletes that named instance's ledger state:

```bash
canton-devkit localnet remove --name canton-dex
```

### Override the generated live parties

By default the wrapper uses the app-provider primary party for operator/admin/
LP-registrar and allocates missing LP/trader and swapper parties through the
JSON Ledger API. To exercise pre-provisioned parties instead, ensure the DevKit
ledger user can act as them, then run:

```bash
DEX_LOCALNET_OPERATOR="<operator-party>" \
DEX_LOCALNET_ADMIN="<admin-party>" \
DEX_LOCALNET_TRADER="<trader-party>" \
DEX_LOCALNET_SWAPPER="<swapper-party>" \
bash scripts/run-localnet-roundtrip.sh canton-dex
```

The LP registrar currently follows `DEX_LOCALNET_ADMIN` for the self-registry
test fixture. The trader and swapper must each differ from the operator. A
production deployment normally uses distinct roles and the participant-specific
setup in [Run against a Canton testnet](run-on-testnet.md).

## Path C: bring your own participant

Neither local launcher is required when you already have a participant. Export
the exact contract-party/package environment listed in
[Testing](../reference/testing.md#live-canton-probes), run the backend package
script from `services/operator-backend`, and treat every live probe as
state-mutating. For a long-lived deployment, follow
[Run against a Canton testnet](run-on-testnet.md).

## Troubleshooting

| Symptom | Meaning and action |
|---|---|
| `dpm: command not found` | Install DPM first; the portable proof cannot start Canton without the pinned SDK. |
| Java class-version/startup error | Activate Java 17 and rerun `java -version`. |
| Canton is not ready after 120 seconds | Read the preserved log directory printed by the proof; check memory and port-binding errors. |
| `/v2/packages` rejects a DAR | The target participant does not accept the committed dependency hash or the DEX DAR was not rebuilt. On a governed network, vet the exact package closure. |
| `USER_NOT_FOUND` | The driver user was not created on a manual participant. The portable script creates it automatically only in its throwaway sandbox. |
| `PERMISSION_DENIED` for `actAs` | The participant JWT user lacks rights for one of `CANTON_OPERATOR`, `CANTON_ADMIN`, `CANTON_LP_REGISTRAR`, or `CANTON_TRADER`. |
| `canton-devkit: command not found` | DevKit is optional; use the DPM sandbox proof or install it through an approved distribution. |

---

**Where to read next:** [AMM-first walkthrough](../tutorials/amm-first-walkthrough.md) · [Testing](../reference/testing.md) · [Deployment](deployment.md)
