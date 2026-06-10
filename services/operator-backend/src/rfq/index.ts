// RFQ flow.
//
// Operator responsibilities:
//   1. Run the matcher: rank inbound quotes by the published policy.
//   2. Build the PolicyReceipt and have the trader+operator co-submit
//      Rfq_Accept (which produces the MatchedTrade with the receipt).
//   3. Drive downstream settlement (handed off to MatchedTrade module).
//
// This module is the WORKED END-TO-END EXAMPLE. Other flow modules
// follow the same shape; if you read one well, you've read them all.

import type { ContractId } from "@canton-dex/registry-client";

import { LedgerSubmitter } from "../ledger/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import { buildReceipt, rankQuotes, POLICY_VERSION } from "../policy/index.js";
import type { Party, PolicyReceipt, Rfq, RfqQuote, Time } from "../types.js";

export interface RfqAcceptInput {
  rfqCid: ContractId<"Rfq">;
  acceptedQuoteCid: ContractId<"RfqQuote">;
  consideredQuoteCids: ContractId<"RfqQuote">[];
  admin: Party;
  now: Time;
  /**
   * Per-caller party binding (B-2): when set, the fetched RFQ's `trader` must
   * equal this, so a caller can only accept on behalf of itself. The handler
   * passes the verified caller party; undefined = binding disabled.
   */
  requireTrader?: Party;
}

/** Thrown when a caller tries to act on an RFQ that is not its own. */
export class RfqAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RfqAuthError";
  }
}

export interface RfqAcceptResult {
  tradeCid: ContractId<"MatchedTrade">;
  receipt: PolicyReceipt;
}

export interface RfqCreateInput {
  trader: Party;
  rfqId: string;
  pair: string;
  side: Rfq["side"];
  size: string;
  expiresAt: Time;
  whitelist: Party[];
  createdAt: Time;
}

export class RfqService {
  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly operatorParty: Party,
  ) {}

  /** List active RFQs visible to the operator (operator is observer). */
  async list(): Promise<{ rfqs: Rfq[]; quotes: RfqQuote[] }> {
    const [rfqs, quotes] = await Promise.all([
      this.ledger.query<Rfq>({
        templateId: "CantonDex.Dex.Rfq:Rfq",
        observingParty: this.operatorParty,
      }),
      this.ledger.query<RfqQuote>({
        templateId: "CantonDex.Dex.Rfq:RfqQuote",
        observingParty: this.operatorParty,
      }),
    ]);
    return { rfqs, quotes };
  }

  /**
   * Find RFQs whose expiresAt has passed but are still open. The operator
   * (or a periodic task) can iterate these and call cancel() to keep the
   * ACS clean and prevent stale quotes from being accepted.
   */
  async listExpired(now: Time): Promise<Rfq[]> {
    const rfqs = await this.ledger.query<Rfq>({
      templateId: "CantonDex.Dex.Rfq:Rfq",
      observingParty: this.operatorParty,
    });
    return rfqs.filter((r) => r.expiresAt <= now);
  }

  /**
   * Sweep expired RFQs under the operator's own authority via the
   * operator-controlled Rfq_Expire choice (Rfq_Cancel is trader-controlled,
   * and the operator cannot act as external-wallet traders). Returns the
   * list of RFQ ids that were expired. Errors per RFQ are logged and
   * swallowed so one stale row does not block the sweep.
   */
  async sweepExpired(now: Time): Promise<string[]> {
    const expired = await this.listExpired(now);
    const swept: string[] = [];
    for (const r of expired) {
      try {
        await this.expire({ rfqCid: r.contractId, rfqId: r.rfqId, now });
        swept.push(r.rfqId);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[rfq] failed to expire ${r.rfqId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return swept;
  }

  /** Archive an expired RFQ under operator authority (Rfq_Expire). */
  async expire(input: {
    rfqCid: ContractId<"Rfq">;
    rfqId: string;
    now: Time;
  }): Promise<void> {
    await retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `rfq-expire:${input.rfqId}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Rfq:Rfq",
          contractId: input.rfqCid,
          choice: "Rfq_Expire",
          argument: { currentTime: input.now },
        },
      }),
    );
  }

  /**
   * Create an RFQ on the trader's behalf. The Rfq template is signatory
   * trader, so this submission carries the trader's authority — in
   * production the trader's wallet does this, but the operator backend
   * accepts the call here so the dApp can drive the live demo path.
   */
  async create(input: RfqCreateInput): Promise<{ rfqCid: ContractId<"Rfq"> }> {
    const rfqCid = await retryOnContention(() =>
      this.ledger.submit<ContractId<"Rfq">>({
        actAs: [input.trader],
        commandId: `rfq-create:${input.rfqId}`,
        command: {
          kind: "create",
          templateId: "CantonDex.Dex.Rfq:Rfq",
          argument: {
            trader: input.trader,
            operator: this.operatorParty,
            rfqId: input.rfqId,
            pair: input.pair,
            side: input.side,
            size: input.size,
            expiresAt: input.expiresAt,
            whitelist: input.whitelist,
            createdAt: input.createdAt,
          },
        },
      }),
    );
    return { rfqCid };
  }

  /** Cancel an open RFQ. Trader-controlled choice. */
  async cancel(input: {
    rfqCid: ContractId<"Rfq">;
    /** Per-caller binding (B-2): when set, must equal the RFQ's trader. */
    requireTrader?: Party;
  }): Promise<void> {
    const rfq = await this.fetchRfq(input.rfqCid);
    if (input.requireTrader !== undefined && rfq.trader !== input.requireTrader) {
      throw new RfqAuthError("caller may only cancel its own RFQ");
    }
    await retryOnContention(() =>
      this.ledger.submit({
        actAs: [rfq.trader],
        commandId: `rfq-cancel:${rfq.rfqId}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Rfq:Rfq",
          contractId: input.rfqCid,
          choice: "Rfq_Cancel",
          argument: {},
        },
      }),
    );
  }

  async accept(input: RfqAcceptInput): Promise<RfqAcceptResult> {
    return retryOnContention(async () => {
      const rfq = await this.fetchRfq(input.rfqCid);
      if (input.requireTrader !== undefined && rfq.trader !== input.requireTrader) {
        throw new RfqAuthError("caller may only accept its own RFQ");
      }
      const quotes = await this.fetchQuotes(input.consideredQuoteCids);
      const ranked = rankQuotes(rfq.side, quotes, input.now);
      const accepted = quotes.find(
        (q) => q.contractId === input.acceptedQuoteCid,
      );
      if (!accepted) {
        throw new Error(
          `accepted quote ${input.acceptedQuoteCid} not in considered set`,
        );
      }
      const acceptedRank = ranked.findIndex(
        (q) => q.contractId === accepted.contractId,
      );
      if (acceptedRank < 0) {
        throw new Error(
          `accepted quote ${input.acceptedQuoteCid} did not survive validity filter`,
        );
      }

      // Receipt is for our records and verification; the on-ledger
      // Rfq_Accept choice computes its own copy from the same inputs.
      const receipt = buildReceipt({
        rfqId: rfq.rfqId,
        side: rfq.side,
        quotes,
        acceptedDealer: accepted.dealer,
        signedBy: this.operatorParty,
        signedAt: input.now,
      });

      const result = await this.ledger.submit<{
        tradeCid: ContractId<"MatchedTrade">;
        receipt: PolicyReceipt;
      }>({
        actAs: [rfq.trader, this.operatorParty],
        commandId: `rfq-accept:${rfq.rfqId}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Rfq:Rfq",
          contractId: input.rfqCid,
          choice: "Rfq_Accept",
          argument: {
            acceptedQuoteCid: input.acceptedQuoteCid,
            consideredQuoteCids: input.consideredQuoteCids,
            admin: input.admin,
            currentTime: input.now,
            signature: receipt.signature,
          },
        },
      });

      return { tradeCid: result.tradeCid, receipt: result.receipt };
    });
  }

  private async fetchRfq(cid: ContractId<"Rfq">): Promise<Rfq> {
    const all = await this.ledger.query<Rfq>({
      templateId: "CantonDex.Dex.Rfq:Rfq",
      observingParty: this.operatorParty,
    });
    const found = all.find((r) => r.contractId === cid);
    if (!found) throw new Error(`Rfq ${cid} not visible`);
    return found;
  }

  private async fetchQuotes(
    cids: ContractId<"RfqQuote">[],
  ): Promise<RfqQuote[]> {
    const all = await this.ledger.query<RfqQuote>({
      templateId: "CantonDex.Dex.Rfq:RfqQuote",
      observingParty: this.operatorParty,
    });
    const byCid = new Map(all.map((q) => [q.contractId as string, q]));
    const out: RfqQuote[] = [];
    for (const cid of cids) {
      const q = byCid.get(cid as string);
      if (!q) throw new Error(`RfqQuote ${cid} not visible to operator`);
      out.push(q);
    }
    return out;
  }
}

export { POLICY_VERSION };
