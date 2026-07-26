// Testnet-only hosted-party onboarding.
//
// A tester lands on the dApp with no Canton identity of their own. Rather than
// make them stand up a validator first, the operator's participant hosts a
// throwaway party for them: allocate the party, create a ledger user whose
// rights are scoped to that one party, and airdrop a fixed amount of the
// configured demo instruments so they have something to trade.
//
// This is a faucet. It exists ONLY for public testnets and is OFF unless
// DEX_TESTNET_ONBOARDING=1 (see `testnetOnboardingFromEnv`). Because it hands
// out ledger authority to anonymous callers, five invariants are load-bearing:
//
//   - The party id is server-generated ("dex-tester-<uuid>"). A caller never
//     supplies a party id or a party hint. Granting CanActAs on a caller-chosen
//     party would let anyone name an existing party -- the operator's own, with
//     the right guess -- and act as it.
//   - The rights granted are CanActAs + CanReadAs on the freshly allocated
//     party and nothing else: no ParticipantAdmin, no rights over the operator
//     / admin / lpRegistrar parties.
//   - The operator's own ledger user is granted CanActAs on that same freshly
//     allocated party, because the airdrop mint needs the tester's authority
//     alongside the admin's. It is granted on parties this faucet just created
//     and on nothing else -- no right over any pre-existing party is added.
//   - Airdrop instruments and amounts come from server config only, clamped to
//     MAX_AIRDROP_AMOUNT, so the faucet cannot be driven to mint unbounded
//     supply.
//   - Every allocation is charged against a per-IP throttle and a global daily
//     cap. Over either, the caller gets an OnboardingThrottleError (the HTTP
//     layer maps it to 429).
//
// The airdrop mints through the registry: Registry_Mint on the admin's
// `CantonDex.Registry.V2:Registry`, which is the only way to get a holding
// that implements the V2 Holding interface and can therefore be swapped. That
// costs a registry cid + a config cid round-trip per grant, and the config cid
// rotates on every mint -- see registry-mint.ts. The registry and its
// instruments are bootstrap state: when either is missing the request fails
// loudly (503) naming the bootstrap step rather than registering anything.
//
// The party is only half of what a tester needs: it lives on the operator's
// participant, so the browser cannot submit for it. `submitForParty` is the
// other half -- a narrow public relay whose command allowlist and server-set
// actAs live in submit.ts. `swapForParty` builds on both: it drives the two
// operator-authority halves of a swap around that relay, for the same reason
// and under the same invariants -- see swap.ts.

import { randomUUID } from "node:crypto";

import type { ContractId, DisclosedContract } from "@canton-dex/registry-client";
import type { LedgerSubmitter } from "../ledger/index.js";
import { isDecimalString } from "../http/validate.js";
import * as dec from "../pool/decimal.js";
import type { PoolService } from "../pool/index.js";
import type { Party, Pool } from "../types.js";
import { rootLogger } from "../lib/logger.js";
import { REGISTRY_HOLDING_TEMPLATE_ID, RegistryMinter } from "./registry-mint.js";
import {
  JsonApiCommandRelay,
  TestnetLedgerError,
  TestnetPartyIneligibleError,
  TestnetSubmitUnavailableError,
  ledgerErrorCode,
  validateCommands,
  type TestnetCommandRelay,
  type TestnetSubmitReceipt,
} from "./submit.js";
import {
  allocateCommand,
  createdAllocationCid,
  dedupeDisclosure,
  selectCoveringHoldings,
  TestnetSwapRejectedError,
  type RegistryHolding,
  type TestnetSwapReceipt,
} from "./swap.js";

const log = rootLogger.child({ component: "testnet-onboarding" });

/** Party hints handed to the participant are always this prefix + a uuid. */
const PARTY_HINT_PREFIX = "dex-tester-";

/**
 * Hard ceiling on a single airdrop grant, independent of config. Config sets
 * the amount; this stops a fat-fingered DEX_TESTNET_AIRDROP from minting a
 * supply that distorts the testnet pools.
 */
const MAX_AIRDROP_AMOUNT = 1_000_000;

const DEFAULT_AIRDROP_SPEC = "dUSD:10000";
const DEFAULT_DAILY_CAP = 200;
const DEFAULT_PER_IP_DAILY_CAP = 3;

// Submissions are far cheaper than party allocations -- they leave no permanent
// topology entry -- and a single trade costs several, so they get their own,
// much looser budget rather than sharing the allocation caps.
const DEFAULT_SUBMIT_DAILY_CAP = 2000;
const DEFAULT_SUBMIT_PER_IP_DAILY_CAP = 200;

/** One instrument's faucet grant, as returned to the caller. */
export interface AirdropGrant {
  instrumentId: string;
  amount: string;
}

/** Response body of POST /v1/testnet/party. */
export interface OnboardedParty {
  partyId: string;
  airdrops: AirdropGrant[];
}

/** Raised when the per-IP throttle or the global daily cap is exhausted. */
export class OnboardingThrottleError extends Error {
  constructor(
    message: string,
    public readonly details: { scope: "ip" | "global"; cap: number },
  ) {
    super(message);
    this.name = "OnboardingThrottleError";
  }
}

/**
 * Participant-side party provisioning. Split out from the service so the
 * JSON API recipe (real participant) and the in-memory dev equivalent are
 * interchangeable, and so tests can drive the flow without Canton.
 */
export interface PartyProvisioner {
  /**
   * Allocate a party from the given server-generated hint, create a ledger
   * user for it, and grant that user CanActAs + CanReadAs on the allocated
   * party ONLY. Returns the fully-qualified party id.
   */
  provision(partyIdHint: string): Promise<string>;
  /** Is `party` hosted on this participant? */
  isHostedHere(party: string): Promise<boolean>;
}

// === JSON API provisioner ==================================================

export interface JsonApiProvisionerConfig {
  /** Base URL of the JSON Ledger API, e.g. http://localhost:7575 */
  baseUrl: string;
  /** Bearer JWT with participant-admin rights (party + user management). */
  token: string;
  /**
   * The operator backend's own ledger user (CANTON_USER_ID). It is granted
   * CanActAs on each party this faucet allocates, because Registry_Mint is
   * `controller admin, owner` and the airdrop submits as both.
   */
  operatorUserId?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

interface PartyDetails {
  party?: string;
  isLocal?: boolean;
}

/**
 * Real-participant provisioner. Party and user management live outside the
 * LedgerSubmitter abstraction (it only submits commands), so this talks to the
 * admin endpoints of the JSON Ledger API directly -- the same calls the deploy
 * script makes by hand:
 *
 *   POST /v2/parties                    allocate
 *   POST /v2/users                      create the tester's user
 *   POST /v2/users/{userId}/rights      grant it CanActAs + CanReadAs
 *   POST /v2/users/{operator}/rights    let the operator act as the new party
 */
export class JsonApiPartyProvisioner implements PartyProvisioner {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: JsonApiProvisionerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async provision(partyIdHint: string): Promise<string> {
    const allocated = (await this.post("/v2/parties", {
      partyIdHint,
      identityProviderId: "",
    })) as { partyDetails?: PartyDetails; party?: string };
    const party = allocated.partyDetails?.party ?? allocated.party;
    if (!party) {
      throw new Error("participant returned no party id for the allocation");
    }

    // The user id is derived from the same server-generated hint, so it is as
    // unguessable as the party and cannot collide with an operator user.
    const userId = partyIdHint;
    await this.post("/v2/users", {
      user: {
        id: userId,
        primaryParty: party,
        isDeactivated: false,
        identityProviderId: "",
      },
      // Rights are granted in the dedicated call below rather than inline, so
      // there is exactly one place to audit what this faucet hands out.
      rights: [],
    });

    await this.post(`/v2/users/${encodeURIComponent(userId)}/rights`, {
      userId,
      rights: [
        { kind: { CanActAs: { value: { party } } } },
        { kind: { CanReadAs: { value: { party } } } },
      ],
    });

    // The airdrop is submitted by the operator backend's own ledger user as
    // `actAs: [admin, party]` (Registry_Mint is controller admin, owner), and
    // that user has no rights over a party allocated seconds ago -- without
    // this the mint fails PERMISSION_DENIED before Daml is reached. Scoped to
    // CanActAs on this one just-created party: no read rights, and never a
    // right over a party the faucet did not allocate.
    const operatorUserId = this.config.operatorUserId;
    if (operatorUserId) {
      await this.post(
        `/v2/users/${encodeURIComponent(operatorUserId)}/rights`,
        {
          userId: operatorUserId,
          rights: [{ kind: { CanActAs: { value: { party } } } }],
        },
      );
    }

    return party;
  }

  async isHostedHere(party: string): Promise<boolean> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v2/parties/${encodeURIComponent(party)}`,
      { headers: { Authorization: `Bearer ${this.config.token}` } },
    );
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(`participant party lookup failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      partyDetails?: PartyDetails | PartyDetails[];
    };
    const details = Array.isArray(body.partyDetails)
      ? body.partyDetails
      : body.partyDetails
        ? [body.partyDetails]
        : [];
    return details.some((d) => d.party === party && d.isLocal === true);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`participant ${path} failed: HTTP ${res.status} ${text}`);
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }
}

// === in-memory provisioner =================================================

/**
 * Dev equivalent for the in-memory ledger, where parties are bare strings and
 * there is no allocation step, no user table and no rights model. It mints a
 * party id in the canonical "hint::fingerprint" shape (so the dApp and the
 * strict party validator see the same form they would on a participant) and
 * remembers what it handed out, which is what "hosted here" means locally.
 */
export class InMemoryPartyProvisioner implements PartyProvisioner {
  private readonly allocated = new Set<string>();

  async provision(partyIdHint: string): Promise<string> {
    // Stand-in for the participant's namespace fingerprint. Only the shape
    // matters here; nothing verifies it on the in-memory ledger.
    const fingerprint = randomUUID().replace(/-/g, "");
    const party = `${partyIdHint}::${fingerprint}`;
    this.allocated.add(party);
    return party;
  }

  async isHostedHere(party: string): Promise<boolean> {
    return this.allocated.has(party);
  }
}

// === config ================================================================

/**
 * Parse DEX_TESTNET_AIRDROP: comma-separated `<instrumentId>:<amount>`.
 * Malformed entries are dropped with a warning rather than failing the boot --
 * a bad faucet config should not take the whole operator backend down. Amounts
 * are clamped to MAX_AIRDROP_AMOUNT.
 */
export function parseAirdropSpec(raw: string | undefined): AirdropGrant[] {
  const spec = raw && raw.trim() ? raw : DEFAULT_AIRDROP_SPEC;
  const out: AirdropGrant[] = [];
  for (const entry of spec.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.lastIndexOf(":");
    const instrumentId = sep < 0 ? "" : trimmed.slice(0, sep).trim();
    const rawAmount = sep < 0 ? "" : trimmed.slice(sep + 1).trim();
    if (!instrumentId || !isDecimalString(rawAmount)) {
      log.warn("ignoring malformed airdrop entry", { entry: trimmed });
      continue;
    }
    const amount = Number(rawAmount);
    if (!(amount > 0)) {
      log.warn("ignoring non-positive airdrop entry", { entry: trimmed });
      continue;
    }
    if (amount > MAX_AIRDROP_AMOUNT) {
      log.warn("clamping airdrop amount to the ceiling", {
        instrumentId,
        requested: rawAmount,
        cap: MAX_AIRDROP_AMOUNT,
      });
    }
    out.push({
      instrumentId,
      amount: toDamlDecimal(
        amount > MAX_AIRDROP_AMOUNT ? String(MAX_AIRDROP_AMOUNT) : rawAmount,
      ),
    });
  }
  return out;
}

/** Pad/truncate a validated decimal string to Daml's 10-digit scale. */
function toDamlDecimal(raw: string): string {
  const [int, frac = ""] = raw.split(".");
  return `${int}.${frac.slice(0, 10).padEnd(10, "0")}`;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    log.warn("ignoring non-positive integer env var", { var: name, value: raw });
    return fallback;
  }
  return n;
}

// === quota =================================================================

/**
 * Per-IP throttle plus a global daily cap, both over the same UTC-day bucket
 * and both held in process memory (a testnet faucet does not need the counts
 * to survive a restart). The per-IP cap is what stops one tester draining the
 * global budget; the global cap bounds the participant's party table.
 *
 * `subject` names what is being charged ("party", "submission") so the two
 * budgets this service keeps produce their own messages.
 */
class OnboardingQuota {
  private day = "";
  private globalCount = 0;
  private perIp = new Map<string, number>();

  constructor(
    private readonly subject: string,
    private readonly dailyCap: number,
    private readonly perIpCap: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Charge one unit to `ip`. Throws when either cap is exhausted. */
  charge(ip: string): void {
    this.rollOver();
    const used = this.perIp.get(ip) ?? 0;
    if (used >= this.perIpCap) {
      throw new OnboardingThrottleError(
        `testnet ${this.subject} quota exhausted for this client (${this.perIpCap}/day)`,
        { scope: "ip", cap: this.perIpCap },
      );
    }
    if (this.globalCount >= this.dailyCap) {
      throw new OnboardingThrottleError(
        `testnet ${this.subject} daily cap reached (${this.dailyCap}/day)`,
        { scope: "global", cap: this.dailyCap },
      );
    }
    this.perIp.set(ip, used + 1);
    this.globalCount += 1;
  }

  private rollOver(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today === this.day) return;
    this.day = today;
    this.globalCount = 0;
    this.perIp = new Map();
  }
}

// === service ===============================================================

export interface TestnetOnboardingConfig {
  ledger: LedgerSubmitter;
  /** Asset admin party: signatory of the airdropped holdings. */
  admin: Party;
  provisioner: PartyProvisioner;
  /** Instruments and amounts handed to each new party. */
  airdrops: AirdropGrant[];
  /** Parties allocated per UTC day across all callers. */
  dailyCap: number;
  /** Parties allocated per UTC day per client address. */
  perIpCap: number;
  /**
   * Relay for hosted-party submissions. Absent on a deployment with no
   * participant behind it (the in-memory dev server), where submitting is
   * simply not a thing this process can do.
   */
  relay?: TestnetCommandRelay;
  /**
   * Pool orchestration, for the two operator-authority halves of
   * `swapForParty`. Absent -> the swap endpoint reports itself unavailable
   * rather than half-driving a trade.
   */
  pool?: PoolService;
  /** Submissions relayed per UTC day across all callers. */
  submitDailyCap: number;
  /** Submissions relayed per UTC day per client address. */
  submitPerIpCap: number;
  /** Injectable clock for the quota window (tests). */
  now?: () => number;
}

export interface CreatePartyInput {
  /** Client address the request is charged to. */
  clientIp: string;
  /** Display-only label from the caller; never influences the party id. */
  label?: string;
}

export interface SubmitForPartyInput {
  /** Party to act as. Accepted only if this faucet minted and hosts it. */
  party: string;
  /** Raw `commands` from the request body; validated against the allowlist. */
  commands: unknown;
  /** Client address the request is charged to. */
  clientIp: string;
  /**
   * Registry disclosure, resolved server-side. A thunk so the round-trip is
   * only paid once the request has earned it -- and so there is no path by
   * which a caller-supplied blob could arrive here.
   */
  resolveDisclosure: () => Promise<DisclosedContract[]>;
}

/**
 * Everything POST /v1/testnet/swap accepts. Notably absent: holding cids,
 * actAs / readAs / userId, and any disclosure -- all four are decided
 * server-side, which is what makes the endpoint safe to leave unauthenticated.
 */
export interface SwapForPartyInput {
  /** The swapper. Accepted only if this faucet minted and hosts it. */
  party: string;
  poolCid: string;
  inputInstrumentId: string;
  inputAmount: string;
  /**
   * Slippage floor. Absent -> the operator's own quote for this input is used,
   * so the swap cannot settle at a worse price than the one it was quoted.
   */
  minOutputAmount?: string;
  /** Client address the request is charged to. */
  clientIp: string;
}

export class TestnetOnboardingService {
  private readonly quota: OnboardingQuota;
  private readonly submitQuota: OnboardingQuota;
  private readonly minter: RegistryMinter;

  constructor(private readonly cfg: TestnetOnboardingConfig) {
    this.quota = new OnboardingQuota(
      "party",
      cfg.dailyCap,
      cfg.perIpCap,
      cfg.now,
    );
    this.submitQuota = new OnboardingQuota(
      "submission",
      cfg.submitDailyCap,
      cfg.submitPerIpCap,
      cfg.now,
    );
    this.minter = new RegistryMinter({ ledger: cfg.ledger, admin: cfg.admin });
  }

  /**
   * Allocate a hosted party for an anonymous tester and fund it. The caller
   * gets no say in the party id: `input.label` is carried into the log line
   * for support purposes and is otherwise inert.
   */
  async createParty(input: CreatePartyInput): Promise<OnboardedParty> {
    // Charge the quota before touching the participant so a throttled caller
    // cannot cost us a party allocation.
    this.quota.charge(input.clientIp);

    const partyIdHint = `${PARTY_HINT_PREFIX}${randomUUID()}`;
    const partyId = await this.cfg.provisioner.provision(partyIdHint);

    const airdrops: AirdropGrant[] = [];
    for (const grant of this.cfg.airdrops) {
      await this.mint(partyId, grant);
      airdrops.push(grant);
    }

    log.info("allocated testnet party", {
      partyId,
      label: input.label,
      airdrops: airdrops.length,
    });
    return { partyId, airdrops };
  }

  async isHostedHere(party: string): Promise<boolean> {
    return this.cfg.provisioner.isHostedHere(party);
  }

  /** Can this deployment relay submissions at all? False on the dev server. */
  canSubmit(): boolean {
    return this.cfg.relay !== undefined;
  }

  /**
   * (a) The party id hint. Only parties this faucet minted carry it, so an
   * operator / admin / lpRegistrar party is refused here, before any lookup --
   * a string check, no I/O, so a hostile request costs the deployment nothing.
   *
   * Shared by every public testnet write; there is exactly one definition of
   * "a party this endpoint may act for" and it is this pair of checks.
   */
  private assertFaucetParty(party: string): void {
    const hint = party.split("::")[0] ?? "";
    if (!party.includes("::") || !hint.startsWith(PARTY_HINT_PREFIX)) {
      throw new TestnetPartyIneligibleError(
        "this endpoint submits only for parties created by the testnet faucet",
        { party },
      );
    }
  }

  /**
   * (b) Hosting. The hint is only a claim; a party that merely LOOKS like a
   * faucet party but lives on another participant is not ours to act for.
   */
  private async assertHostedHere(party: string): Promise<void> {
    if (!(await this.cfg.provisioner.isHostedHere(party))) {
      throw new TestnetPartyIneligibleError(
        "party is not hosted on this participant",
        { party },
      );
    }
  }

  /**
   * Relay a tester's commands under their own party's authority.
   *
   * Order matters and is defensive, cheapest-first:
   *   1. the party is one this faucet minted (a string check, no I/O) and the
   *      commands are all on the allowlist -- a malformed or hostile request is
   *      rejected before it can cost the deployment anything;
   *   2. the quota is charged, so what follows -- a participant round-trip and
   *      a ledger submission -- is bounded per client and per day;
   *   3. the participant confirms it actually hosts the party;
   *   4. the disclosure is resolved server-side and the submission goes out as
   *      exactly this one party.
   */
  async submitForParty(
    input: SubmitForPartyInput,
  ): Promise<TestnetSubmitReceipt> {
    const relay = this.cfg.relay;
    if (!relay) {
      throw new TestnetSubmitUnavailableError(
        "this deployment has no participant to relay testnet submissions to",
      );
    }

    this.assertFaucetParty(input.party);

    const commands = validateCommands(input.commands);

    this.submitQuota.charge(input.clientIp);

    await this.assertHostedHere(input.party);

    const receipt = await relay.submit({
      party: input.party,
      commands,
      disclosedContracts: await input.resolveDisclosure(),
    });
    log.info("relayed testnet submission", {
      party: input.party,
      commands: commands.length,
      choices: commands.map((c) => c.ExerciseCommand.choice),
      updateId: receipt.updateId,
    });
    return receipt;
  }

  /**
   * Drive a whole swap for a faucet party: the operator's PoolRules_RequestSwap,
   * the party's own AllocationFactory_Allocate (through the relay above), and
   * the operator's PoolRules_Swap. See swap.ts for why this exists at all
   * rather than the two operator routes simply dropping their token.
   *
   * Same defensive, cheapest-first order as `submitForParty`, extended over the
   * three steps:
   *   1. the party is one this faucet minted and the amounts parse -- a hostile
   *      or malformed request is refused before anything is queried;
   *   2. the quota is charged, so the operator submissions that follow are
   *      bounded per client and per day;
   *   3. the participant confirms it hosts the party;
   *   4. the pool, the price floor and the input holdings are all resolved
   *      server-side, the holdings from the party's OWN unlocked balance;
   *   5. request -> relay -> settle, with the settle bound to the allocation the
   *      relay actually produced.
   *
   * A swap spends the submission budget twice: once here for the operator work
   * it is about to pay for, and once inside `submitForParty` for the relayed
   * allocation. That is deliberate -- a swap costs the deployment two operator
   * submissions plus a relay, so it should not be as cheap as a bare relay.
   */
  async swapForParty(input: SwapForPartyInput): Promise<TestnetSwapReceipt> {
    const pool = this.cfg.pool;
    if (!pool || !this.cfg.relay) {
      throw new TestnetSubmitUnavailableError(
        "this deployment has no participant to settle testnet swaps on",
      );
    }

    this.assertFaucetParty(input.party);

    // Parse only what has already been shape-checked: parseDecimal assumes a
    // well-formed decimal string and would throw on anything else.
    if (!isDecimalString(input.inputAmount)) {
      throw new TestnetSwapRejectedError(
        "inputAmount must be a Daml Decimal string",
        { field: "inputAmount" },
      );
    }
    const inputUnits = dec.parseDecimal(input.inputAmount);
    if (inputUnits <= 0n) {
      throw new TestnetSwapRejectedError("inputAmount must be positive", {
        field: "inputAmount",
      });
    }
    if (input.minOutputAmount !== undefined) {
      if (
        !isDecimalString(input.minOutputAmount) ||
        dec.parseDecimal(input.minOutputAmount) < 0n
      ) {
        throw new TestnetSwapRejectedError(
          "minOutputAmount must be a non-negative Daml Decimal string",
          { field: "minOutputAmount" },
        );
      }
    }

    this.submitQuota.charge(input.clientIp);

    await this.assertHostedHere(input.party);

    const target = await this.swapPool(pool, input.poolCid);
    if (
      input.inputInstrumentId !== target.baseInstrumentId &&
      input.inputInstrumentId !== target.quoteInstrumentId
    ) {
      throw new TestnetSwapRejectedError(
        "inputInstrumentId is not one of the pool's two instruments",
        { field: "inputInstrumentId" },
      );
    }

    // The security-critical selection: holdings are picked here, from what the
    // ledger says this party OWNS. A caller-supplied cid would let them fund a
    // swap with someone else's balance.
    const holdings = await this.cfg.ledger.query<RegistryHolding>({
      templateId: REGISTRY_HOLDING_TEMPLATE_ID,
      observingParty: input.party,
    });
    const funding = selectCoveringHoldings(
      holdings,
      {
        owner: input.party,
        admin: target.admin,
        instrumentId: input.inputInstrumentId,
      },
      inputUnits,
    );
    if (!funding.cids || funding.cids.length === 0) {
      throw new TestnetSwapRejectedError(
        `insufficient unlocked ${input.inputInstrumentId} balance: ` +
          `have ${dec.formatDecimal(funding.available)}, need ${input.inputAmount}`,
        {
          instrumentId: input.inputInstrumentId,
          available: dec.formatDecimal(funding.available),
          required: input.inputAmount,
        },
      );
    }

    // The operator's own quote. It is both what the receipt reports and, when
    // the caller named no floor, the floor itself -- so an unattended client
    // cannot be settled into a worse price than it was quoted. The trade-off is
    // deliberate: with a zero-tolerance floor, another swap landing on the pool
    // between here and the settle fails this one (502) instead of filling it at
    // a price nobody quoted. A caller that wants slippage room names its own.
    const outputAmount = pool.computeQuote(
      target,
      input.inputInstrumentId,
      input.inputAmount,
    );
    const minOutputAmount = input.minOutputAmount ?? outputAmount;

    // 1. Operator builds, in Daml, the exact spec the party has to author.
    const request = await this.operatorStep("request", () =>
      pool.requestSwap({
        poolCid: input.poolCid as ContractId<"Pool">,
        swapper: input.party,
        inputInstrumentId: input.inputInstrumentId,
        inputAmount: input.inputAmount,
      }),
    );

    // 2. The party authors it, through the same relay a browser would use: the
    // allowlist re-checks the command, actAs is fixed to this one party, and
    // the disclosure is the operator's own -- here, exactly the one the request
    // resolved for the pool's admin.
    const receipt = await this.submitForParty({
      party: input.party,
      commands: [
        allocateCommand({
          factoryCid: request.factoryCid,
          settlement: request.settlement,
          allocation: request.allocationSpec,
          inputHoldingCids: funding.cids,
          party: input.party,
          requestedAt: new Date().toISOString(),
          extraArgs: request.allocationFactoryExtraArgs,
        }),
      ],
      clientIp: input.clientIp,
      resolveDisclosure: async () =>
        dedupeDisclosure(request.allocationFactoryDisclosure),
    });

    // 3. Settle against the allocation the relay actually produced -- never one
    // named by the caller. Falls back to the same updateId discovery the dApp
    // uses when a receipt carries no created events.
    const allocationCid = createdAllocationCid(receipt.createdEvents);
    await this.operatorStep("settle", () =>
      pool.swap({
        poolCid: input.poolCid as ContractId<"Pool">,
        swapperAccount: { owner: input.party, provider: null, id: "" },
        inputInstrumentId: input.inputInstrumentId,
        inputAmount: input.inputAmount,
        minOutputAmount,
        ...(allocationCid
          ? { swapperAllocationCid: allocationCid as ContractId<"Allocation"> }
          : { updateId: receipt.updateId }),
      }),
    );

    log.info("settled a testnet swap", {
      party: input.party,
      poolId: target.poolId,
      inputInstrumentId: input.inputInstrumentId,
      inputAmount: input.inputAmount,
      outputAmount,
      holdings: funding.cids.length,
      updateId: receipt.updateId,
    });
    return {
      updateId: receipt.updateId,
      inputAmount: input.inputAmount,
      outputAmount,
      allocationCid: allocationCid ?? null,
    };
  }

  /** The pool this swap runs against, or a 400-shaped refusal. */
  private async swapPool(pool: PoolService, poolCid: string): Promise<Pool> {
    const found = (await pool.listActive()).find((p) => p.contractId === poolCid);
    if (!found) {
      throw new TestnetSwapRejectedError("unknown or inactive pool", {
        field: "poolCid",
      });
    }
    return found;
  }

  /**
   * Run one operator-authority step and summarize whatever the participant said
   * about it. The raw text can quote the submitted payload back and this
   * endpoint is public, so it is logged here and never put on the wire -- the
   * caller gets the stage and, when one is recognizable, Canton's error id.
   */
  private async operatorStep<T>(
    stage: "request" | "settle",
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log.warn("testnet swap: an operator step failed", { stage, error: detail });
      throw new TestnetLedgerError(
        "ledger_rejected",
        `the ledger rejected the swap at the ${stage} step`,
        { stage, ledgerErrorCode: ledgerErrorCode(detail) },
      );
    }
  }

  private async mint(owner: string, grant: AirdropGrant): Promise<void> {
    // Goes through Registry_Mint so the tester ends up with a V2 holding the
    // swap path can actually allocate. The minter owns the config-cid
    // rotation and the bootstrap-missing failure.
    await this.minter.mint(owner, grant.instrumentId, grant.amount);
  }
}

export interface TestnetOnboardingDeps {
  ledger: LedgerSubmitter;
  admin: Party;
  /** JSON LAPI base URL. Absent -> the in-memory dev provisioner is used. */
  ledgerUrl?: string;
  /** JWT with participant-admin rights. Absent -> in-memory dev provisioner. */
  ledgerToken?: string;
  /**
   * The backend's own ledger user id (CANTON_USER_ID). Needed so the mint,
   * which acts as the tester's party, is permitted for that user.
   */
  userId?: string;
  /** Synchronizer id (CANTON_SYNCHRONIZER) for relayed submissions. */
  synchronizerId?: string;
  /**
   * The backend's pool orchestration, for the operator-authority halves of
   * POST /v1/testnet/swap. Absent -> that one route reports itself unavailable;
   * the party and submit routes are unaffected.
   */
  pool?: PoolService;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the service from the environment, or return undefined when the feature
 * is off. This is the single gate: the HTTP layer registers the testnet routes
 * only when it is handed a service, so with DEX_TESTNET_ONBOARDING unset the
 * paths do not exist at all (404) rather than answering with a "disabled"
 * error.
 *
 *   DEX_TESTNET_ONBOARDING          "1" to enable. Anything else: off.
 *   DEX_TESTNET_PARTY_DAILY_CAP     global allocations per UTC day (200)
 *   DEX_TESTNET_PARTY_IP_DAILY_CAP  per-client allocations per UTC day (3)
 *   DEX_TESTNET_SUBMIT_DAILY_CAP    global submissions per UTC day (2000)
 *   DEX_TESTNET_SUBMIT_IP_DAILY_CAP per-client submissions per UTC day (200)
 *   DEX_TESTNET_AIRDROP             "<instrumentId>:<amount>,..." (dUSD:10000)
 *
 * Prerequisite: every instrument named in DEX_TESTNET_AIRDROP must already be
 * registered on the admin's Registry.V2 -- the airdrop mints through
 * Registry_Mint and registers nothing itself. Run the registry bootstrap
 * (`node --import tsx scripts/bootstrap-registry.ts`) first; requests fail
 * with 503 until it has been run.
 */
export function testnetOnboardingFromEnv(
  deps: TestnetOnboardingDeps,
): TestnetOnboardingService | undefined {
  if (process.env.DEX_TESTNET_ONBOARDING !== "1") return undefined;

  const provisioner: PartyProvisioner =
    deps.ledgerUrl && deps.ledgerToken
      ? new JsonApiPartyProvisioner({
          baseUrl: deps.ledgerUrl,
          token: deps.ledgerToken,
          operatorUserId: deps.userId,
          fetchImpl: deps.fetchImpl,
        })
      : new InMemoryPartyProvisioner();

  // Relaying needs a real participant: the in-memory dev ledger has no
  // submit-and-wait endpoint and no transaction trees to read back, so the dev
  // server simply has no submit route (501) rather than a fake one.
  const relay =
    deps.ledgerUrl && deps.ledgerToken
      ? new JsonApiCommandRelay({
          baseUrl: deps.ledgerUrl,
          token: deps.ledgerToken,
          userId: deps.userId,
          synchronizerId: deps.synchronizerId,
          fetchImpl: deps.fetchImpl,
        })
      : undefined;

  const airdrops = parseAirdropSpec(process.env.DEX_TESTNET_AIRDROP);
  const dailyCap = positiveIntEnv(
    "DEX_TESTNET_PARTY_DAILY_CAP",
    DEFAULT_DAILY_CAP,
  );
  const perIpCap = positiveIntEnv(
    "DEX_TESTNET_PARTY_IP_DAILY_CAP",
    DEFAULT_PER_IP_DAILY_CAP,
  );
  const submitDailyCap = positiveIntEnv(
    "DEX_TESTNET_SUBMIT_DAILY_CAP",
    DEFAULT_SUBMIT_DAILY_CAP,
  );
  const submitPerIpCap = positiveIntEnv(
    "DEX_TESTNET_SUBMIT_IP_DAILY_CAP",
    DEFAULT_SUBMIT_PER_IP_DAILY_CAP,
  );

  log.info("testnet party onboarding enabled", {
    provisioner: provisioner instanceof JsonApiPartyProvisioner ? "participant" : "in-memory",
    dailyCap,
    perIpCap,
    submitRelay: relay ? "participant" : "unavailable",
    swapRoute: relay && deps.pool ? "enabled" : "unavailable",
    submitDailyCap,
    submitPerIpCap,
    airdrops,
  });

  return new TestnetOnboardingService({
    ledger: deps.ledger,
    admin: deps.admin,
    provisioner,
    airdrops,
    dailyCap,
    perIpCap,
    relay,
    pool: deps.pool,
    submitDailyCap,
    submitPerIpCap,
  });
}
