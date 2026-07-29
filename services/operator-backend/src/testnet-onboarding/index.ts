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
// and under the same invariants -- see swap.ts. `orderForParty` and
// `cancelOrderForParty` do the same for a resting order -- see order.ts, which
// also explains why the order's first step cannot go through the relay at all.

import { randomUUID } from "node:crypto";

import type {
  ContractId,
  DisclosedContract,
  RegistryClient,
} from "@canton-dex/registry-client";
import type { DealersService } from "../dealers/index.js";
import { fetchChoiceContext } from "../ledger/choice-context.js";
import type { LedgerSubmitter } from "../ledger/index.js";
import { isCidString, isDecimalString } from "../http/validate.js";
import type { MatchedTradeService } from "../matched-trade/index.js";
import type { MatchRunResult, OrderService } from "../order/index.js";
import * as dec from "../pool/decimal.js";
import type { PoolService } from "../pool/index.js";
import type { RfqService } from "../rfq/index.js";
import type {
  DealerTier,
  Party,
  Pool,
  Rfq,
  RfqQuote,
  Side,
  Time,
  V2AllocationSpecification,
  V2SettlementInfo,
  V2TransferLeg,
} from "../types.js";
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
import {
  createdAllocationCids,
  liquidityAllocateCommands,
  liquidityDisclosure,
  selectLiquidityFunding,
  sumDecimals,
  TestnetLiquidityRejectedError,
  LIQUIDITY_ALLOCATION_COUNT,
  type LiquidityAllocationLeg,
  type TestnetLiquidityAction,
  type TestnetLiquidityReceipt,
} from "./liquidity.js";
import {
  collateralAllocationSpec,
  collateralLeg,
  collateralSettlement,
  findListedPair,
  fundingRequestArgument,
  isOrderSide,
  DEX_PAIR_TEMPLATE_ID,
  ORDER_FUNDING_REQUEST_TEMPLATE_ID,
  TestnetOrderRejectedError,
  type CollateralLeg,
  type DexPairListing,
  type TestnetOrderCancelReceipt,
  type TestnetOrderReceipt,
} from "./order.js";
import {
  dealerQuotePrice,
  dealerSpreadBps,
  isRfqSide,
  legsToSides,
  poolMid,
  rfqExpiry,
  rfqPairString,
  rfqQuoteArgument,
  rfqSize,
  senderSide,
  tradeAllocationSpec,
  RFQ_QUOTE_TEMPLATE_ID,
  TRADE_ALLOCATION_REQUEST_TEMPLATE_ID,
  TestnetRfqRejectedError,
  type TestnetRfqAcceptReceipt,
  type TestnetRfqReceipt,
  type TestnetRfqSide,
  type TradeAllocationRequestContract,
} from "./rfq.js";

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
  /**
   * Order orchestration for `orderForParty` / `cancelOrderForParty`, with the
   * two parties and the registry those flows need alongside it. All of it or
   * none: absent -> the order endpoints report themselves unavailable rather
   * than half-placing an order.
   */
  order?: TestnetOrderDeps;
  /**
   * RFQ orchestration for `rfqForParty` / `rfqAcceptForParty`, with the dealer
   * table, the registry and the operator party those flows need alongside it.
   * All of it or none: absent -> the RFQ endpoints report themselves
   * unavailable rather than half-composing a request for quotes.
   */
  rfq?: TestnetRfqDeps;
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

/**
 * Everything POST /v1/testnet/liquidity accepts. Notably absent, for the same
 * reason as on the swap: holding cids, allocation cids, the request cid,
 * actAs / readAs / userId, and any disclosure -- all decided server-side, which
 * is what makes the endpoint safe to leave unauthenticated.
 */
export interface LiquidityForPartyInput {
  /** The LP. Accepted only if this faucet minted and hosts it. */
  party: string;
  poolCid: string;
  action: TestnetLiquidityAction;
  /** Required on an add, ignored on a remove. */
  baseAmount?: string;
  /** Required on an add, ignored on a remove. */
  quoteAmount?: string;
  /** LP tokens to redeem. Required on a remove, ignored on an add. */
  lpAmount?: string;
  /** Client address the request is charged to. */
  clientIp: string;
}

/**
 * What the order flows need beyond the ledger and the relay. Grouped because
 * they are only useful together: the service drives the operator's bind/fund
 * through `service`, names `operator` on the trader's intent contract, and
 * resolves the allocation factory the collateral step exercises from
 * `registry`.
 */
export interface TestnetOrderDeps {
  service: OrderService;
  registry: RegistryClient;
  /** Operator party: controller of _Bind, Order_Fund and Order_Cancel. */
  operator: Party;
}

/**
 * Everything POST /v1/testnet/order accepts. Notably absent, for the same
 * reason as on the swap: holding cids, the settlement reference, the order and
 * allocation cids, actAs / readAs / userId, and any disclosure -- all decided
 * server-side, which is what makes the endpoint safe to leave unauthenticated.
 */
export interface OrderForPartyInput {
  /** The trader. Accepted only if this faucet minted and hosts it. */
  party: string;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  /** "Bid" or "Ask"; anything else is a 400. */
  side: string;
  limitPrice: string;
  quantity: string;
  /** Good-till time. Absent or null -> good-till-cancelled. */
  expiry?: string | null;
  /** Client address the request is charged to. */
  clientIp: string;
}

/** Everything POST /v1/testnet/order/cancel accepts. */
export interface CancelOrderForPartyInput {
  /** The order's trader, as claimed. Verified against the order itself. */
  party: string;
  orderCid: string;
  /** Client address the request is charged to. */
  clientIp: string;
}

/**
 * Everything POST /v1/testnet/match accepts. Notably absent: any party, any
 * order cid, any price or quantity. Matching clears whatever crosses on the
 * book from orders their owners already placed and funded; the caller supplies
 * only the listed pair to run the operator's own matcher over.
 */
export interface MatchPairInput {
  baseInstrumentId: string;
  quoteInstrumentId: string;
  /** Client address the request is charged to. */
  clientIp: string;
}

/** Response body of POST /v1/testnet/match. Mirrors POST /v1/orders/match. */
export interface TestnetMatchReceipt {
  /** Per-match outcomes, in the order they were settled. */
  matches: MatchRunResult[];
  /** Matches that settled. */
  settled: number;
  /** Matches that failed (each carries its own error in `matches`). */
  failed: number;
}

/**
 * What the RFQ flows need beyond the ledger and the relay. Grouped for the same
 * reason the order deps are: they are only useful together. `service` drives the
 * trader-authority create and the joint accept, `matchedTrade` the two
 * operator-authority halves of settlement, `dealers` supplies both the whitelist
 * and the tier each quote is posted at, and `registry` resolves the allocation
 * factory the counterparties exercise.
 */
export interface TestnetRfqDeps {
  service: RfqService;
  matchedTrade: MatchedTradeService;
  dealers: DealersService;
  registry: RegistryClient;
  /** Operator party: the Rfq's and every quote's observer, and the settle's. */
  operator: Party;
}

/**
 * Everything POST /v1/testnet/rfq accepts. Notably absent, for the same reason
 * as on the swap: the dealer set, the quoted prices, the tiers, the rfqId,
 * actAs / readAs / userId, and any holding or contract id -- all decided
 * server-side, which is what makes the endpoint safe to leave unauthenticated.
 *
 * `pair` is a REQUEST, not an instruction: it is matched against this
 * deployment's own listed pairs and the on-ledger `pair` text is rebuilt from
 * the listing that matched. Rfq_Accept splits that text literally into leg
 * instrument ids, so a caller that could write it would mint legs naming
 * instruments with no registry config.
 */
export interface RfqForPartyInput {
  /** The trader. Accepted only if this faucet minted and hosts it. */
  party: string;
  /** "BASE/QUOTE" against a listed pair. Either this or poolCid. */
  pair?: string;
  /** A pool whose two instruments name the pair. Either this or pair. */
  poolCid?: string;
  /** "RFQ_Buy" or "RFQ_Sell"; anything else is a 400. */
  side: string;
  size: string;
  /** Clamped to [MIN_RFQ_MINUTES, MAX_RFQ_MINUTES]. Absent -> 60. */
  expiryMinutes?: number;
  /** Client address the request is charged to. */
  clientIp: string;
}

/** Everything POST /v1/testnet/rfq/accept accepts. */
export interface RfqAcceptForPartyInput {
  /** The RFQ's trader, as claimed. Verified against the RFQ itself. */
  party: string;
  rfqCid: string;
  acceptedQuoteCid: string;
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

  /**
   * Place a whole resting order for a faucet party: the trader's own funding
   * request, the operator's OrderFundingRequest_Bind, the trader's collateral
   * allocation (through the relay), and the operator's Order_Fund. See order.ts
   * for why the first step cannot go through the relay and is submitted here
   * instead.
   *
   * Same defensive, cheapest-first order as `swapForParty`, extended over the
   * four steps:
   *   1. the party is one this faucet minted and the side / price / quantity
   *      parse -- a hostile or malformed request is refused before anything is
   *      queried;
   *   2. the quota is charged, so the operator submissions that follow are
   *      bounded per client and per day;
   *   3. the participant confirms it hosts the party;
   *   4. the pair, the collateral leg and the funding holdings are all resolved
   *      server-side, the holdings from the party's OWN unlocked balance;
   *   5. request -> bind -> relay -> fund, with the fund bound to the
   *      allocation the relay actually produced.
   *
   * Everything past the bind operates on a live on-ledger Order, so a failure
   * there would strand a Pending order holding nothing. That window is closed
   * with a best-effort cancel before the error is re-raised.
   */
  async orderForParty(input: OrderForPartyInput): Promise<TestnetOrderReceipt> {
    const deps = this.cfg.order;
    if (!deps || !this.cfg.relay) {
      throw new TestnetSubmitUnavailableError(
        "this deployment has no participant to place testnet orders on",
      );
    }

    this.assertFaucetParty(input.party);

    if (!isOrderSide(input.side)) {
      throw new TestnetOrderRejectedError("side must be Bid or Ask", {
        field: "side",
      });
    }
    const side: Side = input.side;
    const limitPrice = this.orderAmount(input.limitPrice, "limitPrice");
    const quantity = this.orderAmount(input.quantity, "quantity");
    const expiry = this.orderExpiry(input.expiry);

    this.submitQuota.charge(input.clientIp);

    await this.assertHostedHere(input.party);

    // The pair bounds the instruments: an order is only placeable on a market
    // this deployment lists, under its own asset admin.
    await this.orderPair(input.baseInstrumentId, input.quoteInstrumentId);

    const collateral = collateralLeg({
      side,
      baseInstrumentId: input.baseInstrumentId,
      quoteInstrumentId: input.quoteInstrumentId,
      limitPrice,
      quantity,
    });

    // The security-critical selection, as on the swap: holdings are picked here
    // from what the ledger says this party OWNS. A caller-supplied cid would
    // let them collateralize an order with someone else's balance.
    const funding = await this.orderFunding(input.party, collateral);

    // The settlement reference is server-generated: it becomes the bind's
    // commandId, which is an idempotency key on the participant, so a
    // caller-chosen one would let two callers collide or one replay another's.
    const settlementRef = `testnet-${randomUUID()}`;

    // 1. The trader's signed intent. It cannot go through the relay (a create
    // is not on its allowlist, by design), so it is submitted here with actAs
    // pinned to the one eligible party -- the same authority the participant
    // granted this backend when the faucet allocated that party.
    const fundingRequestCid = await this.orderStep("request", () =>
      this.cfg.ledger.submit<string>({
        actAs: [input.party],
        commandId: `testnet-order-request:${settlementRef}`,
        command: {
          kind: "create",
          templateId: ORDER_FUNDING_REQUEST_TEMPLATE_ID,
          argument: fundingRequestArgument({
            operator: deps.operator,
            admin: this.cfg.admin,
            party: input.party,
            baseInstrumentId: input.baseInstrumentId,
            quoteInstrumentId: input.quoteInstrumentId,
            side,
            limitPrice,
            quantity,
            expiry,
          }),
        },
      }),
    );

    // 2. Operator binds it, creating the Order (Pending) and the allocation
    // request that describes the collateral.
    const bound = await this.orderStep("bind", () =>
      deps.service.bind({
        fundingRequestCid:
          fundingRequestCid as ContractId<"OrderFundingRequest">,
        settlementRef,
      }),
    );

    try {
      // 3. The trader authors the collateral, through the same relay a browser
      // would use: the allowlist re-checks the command, actAs is fixed to this
      // one party, and the disclosure is the operator's own.
      const [factories, choiceContext] = await Promise.all([
        deps.registry.getFactories(this.cfg.admin),
        fetchChoiceContext(deps.registry, this.cfg.admin),
      ]);
      const receipt = await this.submitForParty({
        party: input.party,
        commands: [
          allocateCommand({
            factoryCid: factories.allocationFactoryCid,
            settlement: collateralSettlement(deps.operator, settlementRef),
            allocation: collateralAllocationSpec({
              admin: this.cfg.admin,
              party: input.party,
              collateral,
              expiry,
            }),
            inputHoldingCids: funding,
            party: input.party,
            requestedAt: new Date().toISOString(),
            extraArgs: choiceContext.extraArgs,
          }),
        ],
        clientIp: input.clientIp,
        resolveDisclosure: async () =>
          dedupeDisclosure([
            ...factories.disclosure,
            ...choiceContext.disclosure,
          ]),
      });

      // 4. Fund against the allocation the relay actually produced -- never one
      // named by the caller. Falls back to the same updateId discovery the dApp
      // uses when a receipt carries no created events. The bind's allocation
      // request goes with it, so it cannot linger once the order is funded.
      const allocationCid = createdAllocationCid(receipt.createdEvents);
      const funded = await this.orderStep("fund", () =>
        deps.service.fund({
          orderCid: bound.orderCid,
          allocationRequestCid: bound.allocationRequestCid,
          ...(allocationCid
            ? { allocationCid: allocationCid as ContractId<"Allocation"> }
            : { updateId: receipt.updateId }),
        }),
      );

      log.info("placed a testnet order", {
        party: input.party,
        side,
        baseInstrumentId: input.baseInstrumentId,
        quoteInstrumentId: input.quoteInstrumentId,
        limitPrice,
        quantity,
        collateral: collateral.amount,
        holdings: funding.length,
        updateId: receipt.updateId,
      });
      return {
        updateId: receipt.updateId,
        orderCid: funded.orderCid,
        status: "Funded",
      };
    } catch (e) {
      await this.cancelStrandedOrder(deps, bound.orderCid);
      throw e;
    }
  }

  /**
   * Cancel a faucet party's resting order, releasing its collateral.
   *
   * Order_Cancel is `controller operator`, so the cancel itself is an operator
   * step -- which is exactly why the ownership check cannot be skipped: the
   * operator can cancel ANY order, so an orderCid taken on trust would let one
   * tester cancel another's. The order is resolved from the operator's own read
   * model and its trader compared to the calling party BEFORE anything is
   * submitted.
   */
  async cancelOrderForParty(
    input: CancelOrderForPartyInput,
  ): Promise<TestnetOrderCancelReceipt> {
    const deps = this.cfg.order;
    if (!deps || !this.cfg.relay) {
      throw new TestnetSubmitUnavailableError(
        "this deployment has no participant to cancel testnet orders on",
      );
    }

    this.assertFaucetParty(input.party);

    if (!isCidString(input.orderCid)) {
      throw new TestnetOrderRejectedError("orderCid must be a contract id", {
        field: "orderCid",
      });
    }

    this.submitQuota.charge(input.clientIp);

    await this.assertHostedHere(input.party);

    const open = await deps.service.listOpen();
    const order = open.find((o) => o.contractId === input.orderCid);
    if (!order) {
      throw new TestnetOrderRejectedError("unknown or inactive order", {
        field: "orderCid",
      });
    }
    // The load-bearing line of this endpoint.
    if (order.trader !== input.party) {
      throw new TestnetPartyIneligibleError(
        "this order was placed by another party",
        { party: input.party },
      );
    }

    const { updateId } = await this.orderStep("cancel", () =>
      deps.service.cancel(order.contractId),
    );
    log.info("cancelled a testnet order", {
      party: input.party,
      orderCid: order.contractId,
      updateId,
    });
    return { updateId };
  }

  /**
   * Run the operator's atomic order matcher over a listed pair, settling every
   * crossing pair on the book in one transaction each. This grants no authority
   * the operator did not already hold: it can only clear orders their owners
   * already placed and funded, on a pair this deployment lists, under the
   * operator's own admin. It takes no party, no order cid and no price/quantity,
   * so it cannot inject an order, choose the clearing price, or redirect funds.
   * The only abuse vector is submission spam, which the submit caps bound; once
   * the book is cleared, repeat calls settle nothing.
   */
  async matchPair(input: MatchPairInput): Promise<TestnetMatchReceipt> {
    const deps = this.cfg.order;
    if (!deps) {
      throw new TestnetSubmitUnavailableError(
        "this deployment has no participant to match testnet orders on",
      );
    }

    // Matching is a write; cap it per client and per day like every other
    // hosted write, before the operator submissions it drives.
    this.submitQuota.charge(input.clientIp);

    // The pair bounds the instruments: matching runs only on a market this
    // deployment lists, under its own asset admin -- the same listing check the
    // order route makes, and it rejects an unlisted pair the same way.
    await this.orderPair(input.baseInstrumentId, input.quoteInstrumentId);

    const matches = await this.matchStep(() =>
      deps.service.runMatching({
        baseInstrumentId: input.baseInstrumentId,
        quoteInstrumentId: input.quoteInstrumentId,
        admin: this.cfg.admin,
      }),
    );
    const failed = matches.filter((m) => m.error).length;

    log.info("ran a testnet order match", {
      baseInstrumentId: input.baseInstrumentId,
      quoteInstrumentId: input.quoteInstrumentId,
      settled: matches.length - failed,
      failed,
    });
    return { matches, settled: matches.length - failed, failed };
  }

  /**
   * Run the matcher and summarize a whole-run failure, for the same reason
   * `orderStep` does: the raw text can quote the submitted payload back and this
   * endpoint is public. Per-match failures are caught inside runMatching and
   * reported in the receipt rather than raised here.
   */
  private async matchStep(
    run: () => Promise<MatchRunResult[]>,
  ): Promise<MatchRunResult[]> {
    try {
      return await run();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log.warn("testnet match: the run failed", { error: detail });
      throw new TestnetLedgerError(
        "ledger_rejected",
        "the ledger rejected the order match run",
        { ledgerErrorCode: ledgerErrorCode(detail) },
      );
    }
  }

  /** A required order amount, or a 400-shaped refusal. */
  private orderAmount(raw: string, field: string): string {
    // Parse only what has already been shape-checked: parseDecimal assumes a
    // well-formed decimal string and would throw on anything else.
    if (!isDecimalString(raw)) {
      throw new TestnetOrderRejectedError(
        `${field} must be a Daml Decimal string`,
        { field },
      );
    }
    if (dec.parseDecimal(raw) <= 0n) {
      throw new TestnetOrderRejectedError(`${field} must be positive`, {
        field,
      });
    }
    return raw;
  }

  /** The order's good-till time, or a 400-shaped refusal. */
  private orderExpiry(raw: string | null | undefined): Time | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
      throw new TestnetOrderRejectedError(
        "expiry must be an ISO-8601 timestamp when present",
        { field: "expiry" },
      );
    }
    return raw as Time;
  }

  /** The pair this order rests on, or a 400-shaped refusal. */
  private async orderPair(
    baseInstrumentId: string,
    quoteInstrumentId: string,
  ): Promise<DexPairListing> {
    const pairs = await this.cfg.ledger.query<DexPairListing>({
      templateId: DEX_PAIR_TEMPLATE_ID,
      observingParty: this.cfg.admin,
    });
    const found = findListedPair(pairs, {
      admin: this.cfg.admin,
      baseInstrumentId,
      quoteInstrumentId,
    });
    if (!found) {
      throw new TestnetOrderRejectedError(
        "this deployment does not list an active pair for those instruments",
        { field: "baseInstrumentId" },
      );
    }
    return found;
  }

  /** The party's own unlocked holdings covering the collateral, or a 400. */
  private async orderFunding(
    party: string,
    collateral: CollateralLeg,
  ): Promise<string[]> {
    const holdings = await this.cfg.ledger.query<RegistryHolding>({
      templateId: REGISTRY_HOLDING_TEMPLATE_ID,
      observingParty: party,
    });
    const selection = selectCoveringHoldings(
      holdings,
      {
        owner: party,
        admin: this.cfg.admin,
        instrumentId: collateral.instrumentId,
      },
      dec.parseDecimal(collateral.amount),
    );
    if (!selection.cids || selection.cids.length === 0) {
      throw new TestnetOrderRejectedError(
        `insufficient unlocked ${collateral.instrumentId} balance: ` +
          `have ${dec.formatDecimal(selection.available)}, need ${collateral.amount}`,
        {
          instrumentId: collateral.instrumentId,
          available: dec.formatDecimal(selection.available),
          required: collateral.amount,
        },
      );
    }
    return selection.cids;
  }

  /**
   * Best-effort release of an order that was bound but never funded. It holds
   * no collateral, so leaving it would only litter the book with an order that
   * can never fill; a failure to clean it up is logged and never masks the
   * error that stranded it.
   */
  private async cancelStrandedOrder(
    deps: TestnetOrderDeps,
    orderCid: ContractId<"Order">,
  ): Promise<void> {
    try {
      await deps.service.cancel(orderCid);
      log.warn("cancelled a testnet order that was bound but never funded", {
        orderCid,
      });
    } catch (e) {
      log.warn("a testnet order is bound but not funded and would not cancel", {
        orderCid,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Run one step of an order flow and summarize whatever the participant said
   * about it, for the same reason `operatorStep` does: the raw text can quote
   * the submitted payload back and this endpoint is public.
   */
  private async orderStep<T>(
    stage: "request" | "bind" | "fund" | "cancel",
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log.warn("testnet order: a step failed", { stage, error: detail });
      throw new TestnetLedgerError(
        "ledger_rejected",
        `the ledger rejected the order at the ${stage} step`,
        { stage, ledgerErrorCode: ledgerErrorCode(detail) },
      );
    }
  }

  /**
   * Drive a whole liquidity change for a faucet party: the operator's
   * PoolLiquidityRules_Request{Add,Remove}Liquidity, the party's own three
   * AllocationFactory_Allocate commands (through the relay above), and the
   * operator's PoolLiquidityRules_Settle{Add,Remove}Liquidity. See liquidity.ts
   * for why this exists at all rather than the four operator routes simply
   * dropping their token, and for why the three allocations are authored as
   * three commands rather than the dApp's single batched one.
   *
   * Same defensive, cheapest-first order as `swapForParty`:
   *   1. the party is one this faucet minted and the amounts this action needs
   *      parse and are positive -- a hostile or malformed request is refused
   *      before anything is queried;
   *   2. the quota is charged, so the operator submissions that follow are
   *      bounded per client and per day;
   *   3. the participant confirms it hosts the party;
   *   4. the pool and the funding holdings are resolved server-side, the
   *      holdings from the party's OWN unlocked balance -- their deposits on an
   *      add, their LP position on a remove -- so a party that could never fund
   *      the change costs the operator no submission;
   *   5. request -> relay -> settle, with the settle bound to the live request
   *      and to the three allocations the relay actually produced.
   *
   * Like a swap, this spends the submission budget twice: once here for the
   * operator work it is about to pay for, and once inside `submitForParty` for
   * the relayed allocations.
   */
  async liquidityForParty(
    input: LiquidityForPartyInput,
  ): Promise<TestnetLiquidityReceipt> {
    const pool = this.cfg.pool;
    if (!pool || !this.cfg.relay) {
      throw new TestnetSubmitUnavailableError(
        "this deployment has no participant to settle testnet liquidity on",
      );
    }

    this.assertFaucetParty(input.party);

    // Only the amounts the named action actually uses are required. The other
    // pair is ignored rather than rejected, so a client that sends one body
    // shape for both actions is not punished for it -- and, more to the point,
    // an amount that does not apply can never reach a choice.
    const isAdd = input.action === "add";
    const baseAmount = isAdd
      ? this.liquidityAmount(input.baseAmount, "baseAmount")
      : "";
    const quoteAmount = isAdd
      ? this.liquidityAmount(input.quoteAmount, "quoteAmount")
      : "";
    const lpAmount = isAdd
      ? ""
      : this.liquidityAmount(input.lpAmount, "lpAmount");

    this.submitQuota.charge(input.clientIp);

    await this.assertHostedHere(input.party);

    const target = await this.liquidityPool(pool, input.poolCid);

    // The security-critical read, as on the swap: what the ledger says this
    // party OWNS. Every funding decision below is taken from it, and nothing
    // from the request body.
    const holdings = await this.cfg.ledger.query<RegistryHolding>({
      templateId: REGISTRY_HOLDING_TEMPLATE_ID,
      observingParty: input.party,
    });

    // One timestamp for the request, the LP's allocations and the settle: the
    // Daml settle re-derives the operator's own legs at `requestedAt`, so the
    // three steps have to agree on it.
    const requestedAt = new Date().toISOString();

    if (isAdd) {
      // Both deposits are funded from the party's own unlocked balance of the
      // pool's two instruments, under the POOL's admin -- a holding of the same
      // instrument from another registry is not this pool's to take.
      const baseFunding = selectLiquidityFunding(
        holdings,
        {
          owner: input.party,
          admin: target.admin,
          instrumentId: target.baseInstrumentId,
        },
        baseAmount,
      );
      const quoteFunding = selectLiquidityFunding(
        holdings,
        {
          owner: input.party,
          admin: target.admin,
          instrumentId: target.quoteInstrumentId,
        },
        quoteAmount,
      );

      // 1. Operator builds, in Daml, the exact three specs the party authors.
      const request = await this.operatorLiquidityStep("request", () =>
        pool.requestAddLiquidity({
          poolCid: input.poolCid as ContractId<"Pool">,
          recipient: input.party,
          baseAmount,
          quoteAmount,
          requestedAt,
        }),
      );

      // 2. The party authors them, through the same relay a browser would use.
      const relayed = await this.relayLiquidityAllocations(
        input,
        request.settlement,
        request.allocations,
        [
          // Deposits: pool-admin factory, funded. LP mint: the registrar's
          // factory, and the party is the RECEIVER, so it locks nothing.
          {
            factoryCid: request.depositFactoryCid,
            extraArgs: request.depositFactoryExtraArgs,
            inputHoldingCids: baseFunding,
          },
          {
            factoryCid: request.depositFactoryCid,
            extraArgs: request.depositFactoryExtraArgs,
            inputHoldingCids: quoteFunding,
          },
          {
            factoryCid: request.lpFactoryCid,
            extraArgs: request.lpFactoryExtraArgs,
            inputHoldingCids: [],
          },
        ],
        liquidityDisclosure(
          request.depositFactoryDisclosure,
          request.lpFactoryDisclosure,
        ),
        requestedAt,
      );

      // 3. Settle against the live request and the allocations the relay
      // actually produced -- never ones named by the caller. The LP floor is
      // the operator's own quote, so the add cannot mint less than quoted.
      await this.settleOrRelease(pool, relayed.allocationCids, target.admin, input.party, () =>
        pool.settleAddLiquidity({
          poolCid: input.poolCid as ContractId<"Pool">,
          requestCid: request.requestCid,
          recipient: input.party,
          lpBaseDepositCid: relayed.allocationCids[0] as ContractId<"Allocation">,
          lpQuoteDepositCid: relayed.allocationCids[1] as ContractId<"Allocation">,
          lpReceiptCid: relayed.allocationCids[2] as ContractId<"Allocation">,
          baseAmount,
          quoteAmount,
          minLpTokens: request.lpAmount,
          knownTotalLpSupply: request.knownTotalLpSupply,
          requestedAt,
        }),
      );

      log.info("settled a testnet add-liquidity", {
        party: input.party,
        poolId: target.poolId,
        baseAmount,
        quoteAmount,
        lpAmount: request.lpAmount,
        holdings: baseFunding.length + quoteFunding.length,
        updateId: relayed.updateId,
      });
      return {
        updateId: relayed.updateId,
        lpAmount: request.lpAmount,
        baseAmount,
        quoteAmount,
      };
    }

    // Remove: only the burn leg is funded, from the party's own unlocked
    // balance of THIS pool's LP token (administered by its lpRegistrar). It is
    // also the ownership check the endpoint needs -- redeeming more than the
    // party holds is refused here, before any operator submission.
    const lpFunding = selectLiquidityFunding(
      holdings,
      {
        owner: input.party,
        admin: target.lpRegistrar,
        instrumentId: target.lpInstrumentId.id,
      },
      lpAmount,
    );

    const request = await this.operatorLiquidityStep("request", () =>
      pool.requestRemoveLiquidity({
        poolCid: input.poolCid as ContractId<"Pool">,
        holder: input.party,
        lpTokensToRedeem: lpAmount,
        requestedAt,
      }),
    );

    const relayed = await this.relayLiquidityAllocations(
      input,
      request.settlement,
      request.allocations,
      [
        // Payout receipts: the party is the receiver, so nothing is locked.
        // The burn: the party is the sender, funded from its LP holdings.
        {
          factoryCid: request.depositFactoryCid,
          extraArgs: request.depositFactoryExtraArgs,
          inputHoldingCids: [],
        },
        {
          factoryCid: request.depositFactoryCid,
          extraArgs: request.depositFactoryExtraArgs,
          inputHoldingCids: [],
        },
        {
          factoryCid: request.lpFactoryCid,
          extraArgs: request.lpFactoryExtraArgs,
          inputHoldingCids: lpFunding,
        },
      ],
      liquidityDisclosure(
        request.depositFactoryDisclosure,
        request.lpFactoryDisclosure,
      ),
      requestedAt,
    );

    // The payout floors default to the operator's own redemption plan -- the
    // same numbers the request quoted -- so an unattended client cannot be
    // settled for less than it was told. Zero-tolerance on purpose, exactly as
    // the swap's default floor is: a pool that moved between request and settle
    // fails this remove (502) instead of paying out an amount nobody quoted.
    const baseOut = sumDecimals(request.baseOuts);
    const quoteOut = sumDecimals(request.quoteOuts);

    await this.settleOrRelease(pool, relayed.allocationCids, target.admin, input.party, () =>
      pool.settleRemoveLiquidity({
        poolCid: input.poolCid as ContractId<"Pool">,
        requestCid: request.requestCid,
        holder: input.party,
        lpTokensToRedeem: lpAmount,
        knownTotalLpSupply: request.knownTotalLpSupply,
        minBaseOut: baseOut,
        minQuoteOut: quoteOut,
        holderBaseReceiptCid: relayed.allocationCids[0] as ContractId<"Allocation">,
        holderQuoteReceiptCid: relayed.allocationCids[1] as ContractId<"Allocation">,
        holderBurnSenderCid: relayed.allocationCids[2] as ContractId<"Allocation">,
        requestedAt,
      }),
    );

    log.info("settled a testnet remove-liquidity", {
      party: input.party,
      poolId: target.poolId,
      lpAmount,
      baseAmount: baseOut,
      quoteAmount: quoteOut,
      holdings: lpFunding.length,
      updateId: relayed.updateId,
    });
    return {
      updateId: relayed.updateId,
      lpAmount,
      baseAmount: baseOut,
      quoteAmount: quoteOut,
    };
  }

  /**
   * Relay the three LP-authority allocations as one submission and read back
   * the allocations it created.
   *
   * They go in ONE submission so the three land atomically: a settle can only
   * bind to all three, so two committed without the third would leave the party
   * with locked funds and nothing to settle them into.
   *
   * A receipt that does not carry exactly three allocations is reported, not
   * settled around. The updateId-discovery fallback the swap uses is not
   * available here: it recovers a LiquidityAllocationAcceptance and drops the
   * request cid, and this flow never creates an acceptance (see liquidity.ts).
   */
  private async relayLiquidityAllocations(
    input: LiquidityForPartyInput,
    settlement: V2SettlementInfo,
    allocations: V2AllocationSpecification[],
    legs: LiquidityAllocationLeg[],
    disclosure: DisclosedContract[],
    requestedAt: string,
  ): Promise<{ updateId: string; allocationCids: string[] }> {
    const receipt = await this.submitForParty({
      party: input.party,
      commands: liquidityAllocateCommands({
        allocations,
        settlement,
        legs,
        party: input.party,
        requestedAt,
      }),
      clientIp: input.clientIp,
      resolveDisclosure: async () => disclosure,
    });

    const allocationCids = createdAllocationCids(receipt.createdEvents);
    if (allocationCids.length !== LIQUIDITY_ALLOCATION_COUNT) {
      log.warn("testnet liquidity: the relayed allocations could not be read back", {
        party: input.party,
        updateId: receipt.updateId,
        allocations: allocationCids.length,
      });
      throw new TestnetLedgerError(
        "tree_fetch_failed",
        "the allocations committed but could not be identified for settlement",
        {
          updateId: receipt.updateId,
          expected: LIQUIDITY_ALLOCATION_COUNT,
          found: allocationCids.length,
        },
      );
    }
    return { updateId: receipt.updateId, allocationCids };
  }

  /** A required liquidity amount, or a 400-shaped refusal. */
  private liquidityAmount(raw: string | undefined, field: string): string {
    // Shape first: parseDecimal assumes a well-formed decimal string and would
    // throw on anything else.
    if (!isDecimalString(raw)) {
      throw new TestnetLiquidityRejectedError(
        `${field} must be a Daml Decimal string`,
        { field },
      );
    }
    if (dec.parseDecimal(raw) <= 0n) {
      throw new TestnetLiquidityRejectedError(`${field} must be positive`, {
        field,
      });
    }
    return raw;
  }

  /** The pool this liquidity change runs against, or a 400-shaped refusal. */
  private async liquidityPool(
    pool: PoolService,
    poolCid: string,
  ): Promise<Pool> {
    const found = (await pool.listActive()).find(
      (p) => p.contractId === poolCid,
    );
    if (!found) {
      throw new TestnetLiquidityRejectedError("unknown or inactive pool", {
        field: "poolCid",
      });
    }
    return found;
  }

  /**
   * Settle a liquidity DvP, and if the settle fails, CANCEL the allocations
   * the party just authored so their funds come back unlocked.
   *
   * Without this the party is stranded. The three allocations lock whole
   * holdings -- this path cannot split, so a 0.01 dBTC add locks the party's
   * entire dBTC holding -- and if the settle then fails, those holdings stay
   * locked with no way back: the UI offers no cancel, `Allocation_Cancel` is
   * the executor's choice and not the owner's, and every later add, remove or
   * swap is refused for insufficient UNLOCKED balance. One failed settle
   * bricks the party for good.
   *
   * The operator is an executor on all three (that is what `settlement`
   * names), so it can cancel them; `allocation_cancelImpl` releases each
   * locked holding and archives the allocation. The cancel is best-effort:
   * the caller still gets the settle's own error, because the settle failing
   * is the thing that went wrong -- the release only decides whether the party
   * can try again.
   */
  private async settleOrRelease<T>(
    pool: PoolService,
    allocationCids: string[],
    admin: Party,
    owner: Party,
    settle: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.operatorLiquidityStep("settle", settle);
    } catch (settleError) {
      try {
        const outcome = await pool.releaseAllocations(allocationCids, admin, owner);
        log.info("testnet liquidity: released the party's allocations after a failed settle", {
          ...outcome,
          allocationCids,
        });
      } catch (releaseError) {
        // Swallowed on purpose: the settle error is the one that describes
        // what failed. Log the release failure so a stranded party is
        // diagnosable from the server side.
        log.error("testnet liquidity: could not release the party's allocations", {
          allocationCids,
          error:
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
        });
      }
      throw settleError;
    }
  }

  /**
   * Run one operator-authority liquidity step and summarize whatever the
   * participant said about it, for the same reason `operatorStep` does: the raw
   * text can quote the submitted payload back and this endpoint is public.
   */
  private async operatorLiquidityStep<T>(
    stage: "request" | "settle",
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log.warn("testnet liquidity: an operator step failed", {
        stage,
        error: detail,
      });
      throw new TestnetLedgerError(
        "ledger_rejected",
        `the ledger rejected the liquidity change at the ${stage} step`,
        { stage, ledgerErrorCode: ledgerErrorCode(detail) },
      );
    }
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

  /**
   * Compose a whole RFQ for a faucet party: the trader's Rfq, plus one
   * dealer-signed RfqQuote per whitelisted dealer. See rfq.ts for why this
   * exists at all rather than the relay learning to accept creates.
   *
   * Same defensive, cheapest-first order as `swapForParty`:
   *   1. the party is one this faucet minted and the side / size / expiry parse
   *      -- a hostile or malformed request is refused before anything is
   *      queried;
   *   2. the quota is charged, so the submissions that follow are bounded per
   *      client and per day;
   *   3. the participant confirms it hosts the party;
   *   4. the pair is resolved against this deployment's OWN listings, the mid
   *      comes from the operator's own pool reserves, and the dealer set comes
   *      from the operator's own table -- none of the three from the body;
   *   5. the Rfq is created as the trader, then each quote as its own dealer.
   */
  async rfqForParty(input: RfqForPartyInput): Promise<TestnetRfqReceipt> {
    const deps = this.cfg.rfq;
    const pool = this.cfg.pool;
    if (!deps || !pool || !this.cfg.relay) {
      throw new TestnetSubmitUnavailableError(
        "this deployment has no participant to compose testnet RFQs on",
      );
    }

    this.assertFaucetParty(input.party);

    if (!isRfqSide(input.side)) {
      throw new TestnetRfqRejectedError("side must be RFQ_Buy or RFQ_Sell", {
        field: "side",
      });
    }
    const side: TestnetRfqSide = input.side;
    const size = rfqSize(input.size, isDecimalString);
    if (
      input.expiryMinutes !== undefined &&
      (typeof input.expiryMinutes !== "number" ||
        !Number.isFinite(input.expiryMinutes))
    ) {
      throw new TestnetRfqRejectedError(
        "expiryMinutes must be a number when present",
        { field: "expiryMinutes" },
      );
    }

    this.submitQuota.charge(input.clientIp);

    await this.assertHostedHere(input.party);

    // The pair bounds the instruments, exactly as it does for an order: an RFQ
    // is only composable on a market this deployment lists, under its own asset
    // admin. The `pair` TEXT is then built from the listing rather than echoed,
    // because Rfq_Accept splits it literally into leg instrument ids.
    const target = await this.rfqPool(pool, input);
    const pair = rfqPairString(target.baseInstrumentId, target.quoteInstrumentId);
    await this.rfqPair(target);

    // The whitelist comes from the operator's own table and never from the
    // body: it decides who may quote AND who observes the Rfq contract.
    const dealers = deps.dealers.list().filter((d) => d.whitelisted);
    if (dealers.length === 0) {
      throw new TestnetRfqRejectedError(
        "this deployment has no whitelisted dealers to quote an RFQ",
        { field: "pair" },
      );
    }

    // The operator's own mid. Every quote below is derived from it, so a caller
    // cannot induce a quote at a price of their choosing.
    const mid = poolMid(target.reserves.baseAmount, target.reserves.quoteAmount);

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = rfqExpiry(now, input.expiryMinutes);
    // Server-generated: the rfqId becomes the commandId of both the create and
    // the accept, which is an idempotency key on the participant, so a
    // caller-chosen one would let two callers collide or one replay another's.
    const rfqId = `testnet-${randomUUID()}`;

    const { rfqCid } = await this.rfqStep("create", () =>
      deps.service.create({
        trader: input.party,
        rfqId,
        pair,
        side,
        size,
        expiresAt,
        whitelist: dealers.map((d) => d.party),
        createdAt,
      }),
    );

    const quotes: TestnetRfqReceipt["quotes"] = [];
    for (const [index, dealer] of dealers.entries()) {
      const tier: DealerTier = dealer.trusted ? "TierTrusted" : "TierWhitelist";
      const price = dealerQuotePrice(
        mid,
        side,
        dealerSpreadBps(index, dealer.trusted),
      );
      try {
        const quoteCid = await this.cfg.ledger.submit<string>({
          // RfqQuote is `signatory dealer`. The dealer is a party this operator
          // allocated and holds CanActAs on -- the same authority the faucet
          // grants itself over every party it creates.
          actAs: [dealer.party],
          commandId: `testnet-rfq-quote:${rfqId}:${index}`,
          command: {
            kind: "create",
            templateId: RFQ_QUOTE_TEMPLATE_ID,
            argument: rfqQuoteArgument({
              dealer: dealer.party,
              trader: input.party,
              operator: deps.operator,
              rfqId,
              price,
              // The quote expires with the RFQ. Rfq_Accept asserts every
              // considered quote is still valid at accept time, so a quote that
              // outlived or predeceased its RFQ could only ever narrow the
              // window in which the trade is acceptable.
              expiresAt,
              postedAt: new Date().toISOString(),
              tier,
            }),
          },
        });
        quotes.push({ dealer: dealer.party, quoteCid, price, tier });
      } catch (e) {
        // One dealer failing to quote is a thin book, not a dead RFQ: the
        // trader can still accept whoever did answer. It is only fatal when
        // nobody did, which is handled below.
        log.warn("testnet rfq: a dealer could not post its quote", {
          rfqId,
          dealer: dealer.party,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (quotes.length === 0) {
      // An RFQ nobody quoted is unacceptable in the literal sense -- Rfq_Accept
      // needs a quote -- so it would sit in the book until the expiry sweep.
      // Withdraw it instead; the trader authority to do so is the same one that
      // created it a moment ago.
      await this.cancelStrandedRfq(deps, rfqCid);
      throw new TestnetLedgerError(
        "ledger_rejected",
        "no dealer could post a quote for this RFQ",
        { rfqId },
      );
    }

    log.info("composed a testnet RFQ", {
      party: input.party,
      rfqId,
      pair,
      side,
      size,
      expiresAt,
      quotes: quotes.length,
    });
    return { rfqId, rfqCid, pair, expiresAt, quotes };
  }

  /**
   * Accept a quote on a faucet party's RFQ and settle the resulting trade end
   * to end: Rfq_Accept, MatchedTrade_RequestAllocations, one
   * AllocationFactory_Allocate per counterparty through the public relay, then
   * MatchedTrade_Settle.
   *
   * The ownership check is not a formality. Rfq_Accept is submitted as
   * [trader, operator] under the operator's own ledger user, which holds
   * CanActAs on every party this faucet allocated -- so without it any caller
   * could accept any faucet party's RFQ. It is checked here AND again inside
   * `RfqService.accept` via `requireTrader`, against the RFQ the ledger
   * actually holds rather than the cid in the body.
   *
   * Rfq_Accept is CONSUMING: it archives the Rfq and every considered quote. A
   * failure after it therefore cannot be unwound, which is why the considered
   * set is read and filtered server-side (a single lapsed cid aborts the choice
   * after the archives) and why the dealers are stocked on both sides before
   * any of this can be reached.
   */
  /**
   * Cancel a hosted party's own RFQ.
   *
   * Without this a hosted party can create and accept but can only get OUT by
   * waiting for expiry: `/v1/rfq/:cid/cancel` is operator-token gated and this
   * deployment sets no token. Same guards as accept, and the ownership check
   * is the load-bearing one -- `RfqService.cancel` takes `requireTrader`, so
   * the RFQ's own trader must be the calling party.
   */
  async rfqCancelForParty(input: {
    party: string;
    rfqCid: string;
    clientIp: string;
  }): Promise<{ rfqId: string }> {
    const deps = this.cfg.rfq;
    if (!deps) {
      throw new TestnetSubmitUnavailableError(
        "this deployment has no participant to cancel testnet RFQs on",
      );
    }

    this.assertFaucetParty(input.party);

    if (!isCidString(input.rfqCid)) {
      throw new TestnetRfqRejectedError("rfqCid must be a contract id", {
        field: "rfqCid",
      });
    }

    this.submitQuota.charge(input.clientIp);

    await this.assertHostedHere(input.party);

    const { rfqs } = await deps.service.list();
    const rfq = rfqs.find((r) => r.contractId === input.rfqCid);
    if (!rfq) {
      throw new TestnetRfqRejectedError("unknown or inactive RFQ", {
        field: "rfqCid",
      });
    }
    if (rfq.trader !== input.party) {
      throw new TestnetPartyIneligibleError(
        "this RFQ was created by another party",
        { field: "rfqCid" },
      );
    }

    await deps.service.cancel({
      rfqCid: input.rfqCid as ContractId<"Rfq">,
      requireTrader: input.party as Party,
    });
    return { rfqId: rfq.rfqId };
  }

  async rfqAcceptForParty(
    input: RfqAcceptForPartyInput,
  ): Promise<TestnetRfqAcceptReceipt> {
    const deps = this.cfg.rfq;
    if (!deps || !this.cfg.relay) {
      throw new TestnetSubmitUnavailableError(
        "this deployment has no participant to settle testnet RFQs on",
      );
    }

    this.assertFaucetParty(input.party);

    for (const field of ["rfqCid", "acceptedQuoteCid"] as const) {
      if (!isCidString(input[field])) {
        throw new TestnetRfqRejectedError(`${field} must be a contract id`, {
          field,
        });
      }
    }

    this.submitQuota.charge(input.clientIp);

    await this.assertHostedHere(input.party);

    const { rfqs, quotes } = await deps.service.list();
    const rfq = rfqs.find((r) => r.contractId === input.rfqCid);
    if (!rfq) {
      throw new TestnetRfqRejectedError("unknown or inactive RFQ", {
        field: "rfqCid",
      });
    }
    // The load-bearing line of this endpoint.
    if (rfq.trader !== input.party) {
      throw new TestnetPartyIneligibleError(
        "this RFQ was composed by another party",
        { party: input.party },
      );
    }

    const now = new Date().toISOString();
    const considered = this.consideredQuotes(rfq, quotes, now);
    if (!considered.some((q) => q.contractId === input.acceptedQuoteCid)) {
      throw new TestnetRfqRejectedError(
        "that quote is not a live quote on this RFQ",
        { field: "acceptedQuoteCid" },
      );
    }

    const accepted = await this.rfqStep("accept", () =>
      deps.service.accept({
        rfqCid: rfq.contractId,
        acceptedQuoteCid: input.acceptedQuoteCid as ContractId<"RfqQuote">,
        // Read from the ledger and filtered here, never taken from the body:
        // Rfq_Accept asserts every considered quote is still unexpired, and the
        // choice is consuming, so one lapsed cid aborts it after the Rfq and
        // every quote would have been archived, with no unwind.
        consideredQuoteCids: considered.map((q) => q.contractId),
        admin: this.cfg.admin,
        now,
        requireTrader: input.party,
      }),
    );

    const requestCids = await this.rfqStep("request-allocations", () =>
      deps.matchedTrade.requestAllocations({ tradeCid: accepted.tradeCid }),
    );
    const requests = await this.tradeAllocationRequests(requestCids);

    // The factory and its disclosure are the operator's own, as on every other
    // relayed step: a caller-supplied blob would let anyone hand the
    // participant a contract of their choosing.
    const [factories, choiceContext] = await Promise.all([
      deps.registry.getFactories(this.cfg.admin),
      fetchChoiceContext(deps.registry, this.cfg.admin),
    ]);
    const disclosure = dedupeDisclosure([
      ...factories.disclosure,
      ...choiceContext.disclosure,
    ]);

    // Grouped by the request's own admin: a batch's allocations must cover
    // exactly its admin's legs. Legs repeat across a pair's two requests, so
    // they are deduplicated by id.
    const batches = new Map<
      Party,
      { allocationCids: string[]; transferLegs: V2TransferLeg[] }
    >();
    const batchFor = (admin: Party) => {
      const existing = batches.get(admin);
      if (existing) return existing;
      const fresh = { allocationCids: [], transferLegs: [] };
      batches.set(admin, fresh);
      return fresh;
    };

    let updateId = "";
    for (const request of requests) {
      // Deliberately NOT AllocationRequest_Accept: it archives the request, and
      // MatchedTrade_Settle fetches and archives them itself. Authoring the
      // allocation directly leaves the settle the state it expects.
      const cid = await this.relayTradeAllocation(
        request,
        factories.allocationFactoryCid,
        choiceContext.extraArgs,
        disclosure,
        input.clientIp,
      );
      const batch = batchFor(request.admin);
      batch.allocationCids.push(cid.allocationCid);
      for (const leg of request.transferLegs) {
        if (!batch.transferLegs.some((l) => l.transferLegId === leg.transferLegId)) {
          batch.transferLegs.push(leg);
        }
      }
      updateId = cid.updateId;
    }

    await this.rfqStep("settle", () =>
      deps.matchedTrade.settle({
        tradeCid: accepted.tradeCid,
        batchesByAdmin: new Map(
          [...batches].map(([admin, batch]) => [
            admin,
            {
              allocationCids: batch.allocationCids as ContractId<"Allocation">[],
              transferLegs: batch.transferLegs,
            },
          ]),
        ),
        // Passed, not empty. MatchedTrade_Settle fetches and archives each of
        // these as its first act, and the usual reason to withhold them --
        // a counterparty that used AllocationRequest_Accept has already
        // archived its own -- does not apply here: every counterparty above
        // authored its allocation DIRECTLY, so its request is provably still
        // active. Withholding them settles just as well but leaves one orphan
        // request per counterparty on the ledger for good, visible to that
        // counterparty as a pending ask against a trade that has already
        // settled.
        allocationRequestCids: requests.map(
          (r) => r.contractId as ContractId<"TradeAllocationRequest">,
        ),
        dexPairCid: null,
      }),
    );

    log.info("settled a testnet RFQ", {
      party: input.party,
      rfqId: rfq.rfqId,
      tradeCid: accepted.tradeCid,
      acceptedDealer: accepted.receipt.acceptedDealer,
      acceptedRank: accepted.receipt.acceptedRank,
      allocations: [...batches.values()].reduce(
        (n, b) => n + b.allocationCids.length,
        0,
      ),
      updateId,
    });
    return {
      tradeCid: accepted.tradeCid,
      acceptedDealer: accepted.receipt.acceptedDealer,
      acceptedRank: accepted.receipt.acceptedRank,
      consideredCount: accepted.receipt.consideredCount,
      receipt: accepted.receipt,
      updateId,
    };
  }

  /**
   * Author one counterparty's side of the trade through the PUBLIC relay -- the
   * same path a browser would take, with the same allowlist re-check and the
   * same server-fixed actAs.
   *
   * The funding is the security-critical part, as on the swap: holdings are
   * selected here from what the ledger says the AUTHORIZER owns. A receiver
   * locks nothing, so it funds with an empty list.
   */
  private async relayTradeAllocation(
    request: TradeAllocationRequestContract,
    factoryCid: string,
    extraArgs: unknown,
    disclosure: DisclosedContract[],
    clientIp: string,
  ): Promise<{ allocationCid: string; updateId: string }> {
    const party = request.authorizer.owner as Party;
    const sides = legsToSides(request.authorizer, request.transferLegs);
    const leg = senderSide(sides);

    let inputHoldingCids: string[] = [];
    if (leg) {
      const holdings = await this.cfg.ledger.query<RegistryHolding>({
        templateId: REGISTRY_HOLDING_TEMPLATE_ID,
        observingParty: party,
      });
      const selection = selectCoveringHoldings(
        holdings,
        { owner: party, admin: request.admin, instrumentId: leg.instrumentId },
        dec.parseDecimal(leg.amount),
      );
      if (!selection.cids || selection.cids.length === 0) {
        // Reached only after Rfq_Accept has consumed the RFQ and its quotes, so
        // there is nothing to unwind -- which is exactly why the dealers are
        // stocked on both sides of the pair before the route goes live.
        throw new TestnetRfqRejectedError(
          `a counterparty cannot cover ${leg.amount} ${leg.instrumentId}: ` +
            `unlocked ${dec.formatDecimal(selection.available)}`,
          {
            party,
            instrumentId: leg.instrumentId,
            available: dec.formatDecimal(selection.available),
            required: leg.amount,
          },
        );
      }
      inputHoldingCids = selection.cids;
    }

    const receipt = await this.submitForParty({
      party,
      commands: [
        allocateCommand({
          factoryCid,
          settlement: request.settlement,
          allocation: tradeAllocationSpec(request),
          inputHoldingCids,
          party,
          requestedAt: new Date().toISOString(),
          extraArgs,
        }),
      ],
      clientIp,
      resolveDisclosure: async () => disclosure,
    });

    const allocationCid = createdAllocationCid(receipt.createdEvents);
    if (!allocationCid) {
      // Not softened into a settle-by-updateId fallback the way the swap's is:
      // a settle binds to every counterparty's allocation at once, so one
      // missing cid is not recoverable from the other's update.
      throw new TestnetLedgerError(
        "tree_fetch_failed",
        "an allocation committed but could not be identified for settlement",
        { updateId: receipt.updateId, party },
      );
    }
    return { allocationCid, updateId: receipt.updateId };
  }

  /** The live quotes on this RFQ, as the operator's own read model sees them. */
  private consideredQuotes(rfq: Rfq, quotes: RfqQuote[], now: Time): RfqQuote[] {
    return quotes.filter(
      (q) => q.rfqId === rfq.rfqId && Date.parse(q.expiresAt) > Date.parse(now),
    );
  }

  /** The allocation asks this trade just produced, with their payloads. */
  private async tradeAllocationRequests(
    cids: ContractId<"TradeAllocationRequest">[],
  ): Promise<TradeAllocationRequestContract[]> {
    // The choice returns the new cids; this read is only to recover their
    // PAYLOADS (settlement, legs, authorizer), which the result does not carry.
    // Filtered to the returned cids -- an earlier trade can leave other
    // requests on the ledger, and taking the newest would settle someone
    // else's.
    const wanted = new Set<string>(cids as unknown as string[]);
    const rows = await this.cfg.ledger.query<TradeAllocationRequestContract>({
      templateId: TRADE_ALLOCATION_REQUEST_TEMPLATE_ID,
      observingParty: this.cfg.rfq!.operator,
    });
    const mine = rows.filter((r) => wanted.has(r.contractId));
    if (mine.length !== wanted.size) {
      throw new TestnetLedgerError(
        "tree_fetch_failed",
        "the trade's allocation requests could not be read back",
        { expected: wanted.size, found: mine.length },
      );
    }
    return mine;
  }

  /** The pool an RFQ is priced off, named either directly or by its pair. */
  private async rfqPool(pool: PoolService, input: RfqForPartyInput): Promise<Pool> {
    const pools = await pool.listActive();
    if (input.poolCid !== undefined) {
      const found = pools.find((p) => p.contractId === input.poolCid);
      if (!found) {
        throw new TestnetRfqRejectedError("unknown or inactive pool", {
          field: "poolCid",
        });
      }
      return found;
    }
    if (typeof input.pair !== "string" || !input.pair.includes("/")) {
      throw new TestnetRfqRejectedError(
        'pair must be "BASE/QUOTE", or name a pool with poolCid',
        { field: "pair" },
      );
    }
    const [base, quote] = input.pair.split("/");
    const found = pools.find(
      (p) => p.baseInstrumentId === base && p.quoteInstrumentId === quote,
    );
    if (!found) {
      throw new TestnetRfqRejectedError(
        "this deployment has no active pool for that pair",
        { field: "pair" },
      );
    }
    return found;
  }

  /** The pair listing behind an RFQ, or a 400-shaped refusal. */
  private async rfqPair(target: Pool): Promise<DexPairListing> {
    const pairs = await this.cfg.ledger.query<DexPairListing>({
      templateId: DEX_PAIR_TEMPLATE_ID,
      observingParty: this.cfg.admin,
    });
    const found = findListedPair(pairs, {
      admin: this.cfg.admin,
      baseInstrumentId: target.baseInstrumentId,
      quoteInstrumentId: target.quoteInstrumentId,
    });
    if (!found) {
      throw new TestnetRfqRejectedError(
        "this deployment does not list an active pair for those instruments",
        { field: "pair" },
      );
    }
    return found;
  }

  /**
   * Best-effort withdrawal of an RFQ nobody could quote. It holds no funds, so
   * leaving it would only litter the book with a request that can never be
   * accepted; a failure to clean it up is logged and never masks the error that
   * stranded it.
   */
  private async cancelStrandedRfq(
    deps: TestnetRfqDeps,
    rfqCid: ContractId<"Rfq">,
  ): Promise<void> {
    try {
      await deps.service.cancel({ rfqCid });
      log.warn("cancelled a testnet RFQ that no dealer would quote", { rfqCid });
    } catch (e) {
      log.warn("a testnet RFQ has no quotes and would not cancel", {
        rfqCid,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Run one step of an RFQ flow and summarize whatever the participant said
   * about it, for the same reason `operatorStep` does: the raw text can quote
   * the submitted payload back and this endpoint is public.
   */
  private async rfqStep<T>(
    stage: "create" | "accept" | "request-allocations" | "settle",
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (e) {
      // A refusal this module raised itself is already caller-shaped and
      // caller-safe; only a ledger failure needs summarizing.
      if (e instanceof TestnetRfqRejectedError) throw e;
      const detail = e instanceof Error ? e.message : String(e);
      log.warn("testnet rfq: a step failed", { stage, error: detail });
      throw new TestnetLedgerError(
        "ledger_rejected",
        `the ledger rejected the RFQ at the ${stage} step`,
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
  /**
   * The backend's order orchestration + the registry and operator party the
   * order flows need, for POST /v1/testnet/order and its cancel. Absent ->
   * those two routes report themselves unavailable; every other route is
   * unaffected.
   */
  order?: TestnetOrderDeps;
  /**
   * The backend's RFQ + matched-trade orchestration, the dealer table, the
   * registry and the operator party, for POST /v1/testnet/rfq and its accept.
   * Absent -> those two routes report themselves unavailable; every other route
   * is unaffected.
   */
  rfq?: TestnetRfqDeps;
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
    liquidityRoute: relay && deps.pool ? "enabled" : "unavailable",
    orderRoute: relay && deps.order ? "enabled" : "unavailable",
    rfqRoute: relay && deps.rfq && deps.pool ? "enabled" : "unavailable",
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
    order: deps.order,
    rfq: deps.rfq,
    submitDailyCap,
    submitPerIpCap,
  });
}
