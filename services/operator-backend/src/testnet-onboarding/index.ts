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

import { randomUUID } from "node:crypto";

import type { LedgerSubmitter } from "../ledger/index.js";
import { isDecimalString } from "../http/validate.js";
import type { Party } from "../types.js";
import { rootLogger } from "../lib/logger.js";
import { RegistryMinter } from "./registry-mint.js";

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
 */
class OnboardingQuota {
  private day = "";
  private globalCount = 0;
  private perIp = new Map<string, number>();

  constructor(
    private readonly dailyCap: number,
    private readonly perIpCap: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Charge one allocation to `ip`. Throws when either cap is exhausted. */
  charge(ip: string): void {
    this.rollOver();
    const used = this.perIp.get(ip) ?? 0;
    if (used >= this.perIpCap) {
      throw new OnboardingThrottleError(
        `testnet party quota exhausted for this client (${this.perIpCap}/day)`,
        { scope: "ip", cap: this.perIpCap },
      );
    }
    if (this.globalCount >= this.dailyCap) {
      throw new OnboardingThrottleError(
        `testnet party daily cap reached (${this.dailyCap}/day)`,
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
  /** Injectable clock for the quota window (tests). */
  now?: () => number;
}

export interface CreatePartyInput {
  /** Client address the request is charged to. */
  clientIp: string;
  /** Display-only label from the caller; never influences the party id. */
  label?: string;
}

export class TestnetOnboardingService {
  private readonly quota: OnboardingQuota;
  private readonly minter: RegistryMinter;

  constructor(private readonly cfg: TestnetOnboardingConfig) {
    this.quota = new OnboardingQuota(cfg.dailyCap, cfg.perIpCap, cfg.now);
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
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the service from the environment, or return undefined when the feature
 * is off. This is the single gate: the HTTP layer registers the two testnet
 * routes only when it is handed a service, so with DEX_TESTNET_ONBOARDING
 * unset the paths do not exist at all (404) rather than answering with a
 * "disabled" error.
 *
 *   DEX_TESTNET_ONBOARDING          "1" to enable. Anything else: off.
 *   DEX_TESTNET_PARTY_DAILY_CAP     global allocations per UTC day (200)
 *   DEX_TESTNET_PARTY_IP_DAILY_CAP  per-client allocations per UTC day (3)
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

  const airdrops = parseAirdropSpec(process.env.DEX_TESTNET_AIRDROP);
  const dailyCap = positiveIntEnv(
    "DEX_TESTNET_PARTY_DAILY_CAP",
    DEFAULT_DAILY_CAP,
  );
  const perIpCap = positiveIntEnv(
    "DEX_TESTNET_PARTY_IP_DAILY_CAP",
    DEFAULT_PER_IP_DAILY_CAP,
  );

  log.info("testnet party onboarding enabled", {
    provisioner: provisioner instanceof JsonApiPartyProvisioner ? "participant" : "in-memory",
    dailyCap,
    perIpCap,
    airdrops,
  });

  return new TestnetOnboardingService({
    ledger: deps.ledger,
    admin: deps.admin,
    provisioner,
    airdrops,
    dailyCap,
    perIpCap,
  });
}
