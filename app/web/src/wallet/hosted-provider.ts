import { composeCommands } from "./commands";
import { discoverHoldingsAcrossRegistries, resolveSpendableHoldings, type AcsRequest } from "./holdings";
import { submitComposedCommands, type PreparedSubmission } from "./sequential-submit";
import { from64, sha256, sign, verifyPrepared, verifyTopology, type HostedConfig, type Topology } from "./hosted-crypto";
import { approveHosted, requestKeys } from "./hosted-dialog";
import type { WalletProvider, WalletConnectionStatus, WalletAccount, WalletIntent, WalletResult } from "./types";
import type { InstrumentId } from "@/types/contracts";

export class HostedWalletProvider implements WalletProvider {
  readonly id = "hosted";
  readonly label = "Testnet wallet · your signing key";
  private status: WalletConnectionStatus = { kind: "disconnected" };
  private listeners = new Set<(s: WalletConnectionStatus) => void>();
  private key: CryptoKey | null = null;
  private publicKey = "";
  private config: HostedConfig | null = null;
  private busy = false;

  constructor(private readonly apiBase: string, private readonly packagePrefix: string, private readonly network: string) {}
  getStatus(): WalletConnectionStatus { return this.status; }
  onStatusChange(cb: (s: WalletConnectionStatus) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private setStatus(status: WalletConnectionStatus): void { this.status = status; for (const cb of this.listeners) cb(status); }
  private async post<T>(action: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBase}/v1/hosted-wallet/${action}`, {
      method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000),
    });
    const value = await res.json();
    if (!res.ok) throw new Error(value.error ?? `Wallet request failed (${res.status})`);
    return value as T;
  }
  private async request<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.key || !this.config) throw new Error("Unlock your wallet first.");
    const key = this.key;
    const payloadHash = await sha256(JSON.stringify(payload));
    const challenge = await this.post<{ nonce: string; message: string; expires: number }>("challenge", { publicKey: this.publicKey, action, payloadHash });
    const expected = JSON.stringify({ purpose: "Canton DEX hosted wallet request", ...this.config, publicKey: this.publicKey, action, payloadHash, nonce: challenge.nonce, expires: challenge.expires });
    if (challenge.message !== expected || challenge.expires < Date.now() || challenge.expires > Date.now() + 130_000) throw new Error("Unexpected wallet authentication challenge.");
    return this.post<T>(action, { nonce: challenge.nonce, payload, signature: await sign(key, new TextEncoder().encode(expected)) });
  }
  async connect(): Promise<WalletAccount> {
    this.setStatus({ kind: "connecting" });
    try {
      const cfg = await this.post<HostedConfig>("config");
      if (cfg.origin !== window.location.origin || cfg.network !== this.network) throw new Error("Hosted wallet site or network mismatch.");
      this.config = cfg;
      const keys = await requestKeys(cfg.origin, cfg.network);
      this.key = keys.key; this.publicKey = keys.vault.publicKey;
      const topology = await this.request<Topology>("topology", {});
      await verifyTopology(topology, this.publicKey, cfg);
      if (!topology.allocated) {
        await approveHosted("Create external party", `Your key controls ${topology.partyId}\nHosted by ${cfg.participantId}\nNetwork: ${cfg.network}`, JSON.stringify(topology, null, 2));
        await this.request("allocate", { topologySignature: await sign(this.key, from64(topology.multiHash)) });
      }
      const account = { party: topology.partyId, label: this.label };
      this.setStatus({ kind: "connected", account, providerId: this.id });
      return account;
    } catch (e) {
      this.key = null; this.publicKey = "";
      this.setStatus({ kind: "error", message: e instanceof Error ? e.message : "Wallet connection failed" });
      throw e;
    }
  }
  async disconnect(): Promise<void> { this.key = null; this.publicKey = ""; this.config = null; this.setStatus({ kind: "disconnected" }); }
  async authenticateSession(): Promise<string> {
    return (await this.request<{ callerToken: string }>("session", {})).callerToken;
  }
  private party(): string {
    if (this.status.kind !== "connected") throw new Error("Wallet is disconnected");
    return this.status.account.party;
  }
  private async read(owner: string, req: AcsRequest): Promise<unknown> {
    if (owner !== this.party()) throw new Error("Cannot read another party's wallet");
    if (req.resource === "/v2/state/ledger-end") return { offset: 0 };
    if (req.resource !== "/v2/state/active-contracts") throw new Error("Unsupported wallet read");
    const body = req.body as { filter?: { filtersByParty?: Record<string, { cumulative?: unknown[] }> } };
    return this.request("holdings", { party: owner, filters: body.filter?.filtersByParty?.[owner]?.cumulative ?? [] });
  }
  async listHoldings(owner: string) { return discoverHoldingsAcrossRegistries(owner, this.packagePrefix, req => this.read(owner, req)); }
  async resolveSpendableHoldings(owner: string, instrument: InstrumentId) { return resolveSpendableHoldings(owner, instrument, this.packagePrefix, req => this.read(owner, req)); }

  async submit(intent: WalletIntent): Promise<WalletResult> {
    if (this.busy) throw new Error("Finish the current wallet approval first.");
    const party = this.party();
    this.busy = true;
    const allocations = new Map<string, string>();
    let orderCid: string | undefined;
    try {
      const composed = composeCommands(intent, { party, packagePrefix: this.packagePrefix, now: () => new Date() });
      const result = await submitComposedCommands({
        intent, composed, party, supportsMultiCommandTransaction: false,
        submit: async submission => {
          const result = await this.submitOne(submission);
          const tx = result.transaction as { updateId: string; events: Array<{ CreatedEvent?: { contractId: string; templateId: string } }> };
          if (!tx?.updateId) throw new Error("Signed transaction returned no update ID; check its status before retrying.");
          const creates = (tx.events ?? []).flatMap(e => e.CreatedEvent ? [e.CreatedEvent] : []);
          const created = creates.filter(e => e.templateId.endsWith(":Allocation"));
          if (created.length === 1) allocations.set(tx.updateId, created[0].contractId);
          orderCid = creates.find(e => e.templateId.endsWith(":OrderFundingRequest"))?.contractId ?? orderCid;
          return tx.updateId;
        },
        recover: async updateId => {
          const cid = allocations.get(updateId);
          if (!cid) throw new Error(`No unique allocation returned for update ${updateId}`);
          return cid;
        },
      });
      if (intent.kind === "place-order") {
        if (!orderCid) throw new Error("Order authorization completed but its contract ID is unavailable.");
        return { ...result, primaryCid: orderCid };
      }
      const single = result.auxiliaryCids?.updateId;
      if (single && allocations.has(single)) result.createdAllocationCids = [allocations.get(single)!];
      return result;
    } finally { this.busy = false; }
  }
  private async submitOne(submission: PreparedSubmission): Promise<Record<string, unknown>> {
    if (!this.config || !this.key) throw new Error("Wallet locked");
    const prepared = await this.request<{ id: string; preparedTransaction: string; preparedTransactionHash: string; hashingSchemeVersion: string }>("prepare", { ...submission });
    const details = await verifyPrepared(prepared, submission, this.config);
    const command = submission.commands[0];
    const args = "ExerciseCommand" in command ? command.ExerciseCommand.choiceArgument : "CreateCommand" in command ? command.CreateCommand.createArguments : {};
    const allocation = args.allocation as { admin: string; committed: boolean; transferLegSides: Array<{ side: string; amount: string; instrumentId: string; otherside: { owner: string | null; id: string } }> } | undefined;
    const summary = allocation
      ? allocation.transferLegSides.map(leg => `${leg.side === "SenderSide" ? "Send" : "Receive"} ${leg.amount} ${leg.instrumentId}\nAsset admin: ${allocation.admin}\nCounterparty: ${leg.otherside.owner ?? leg.otherside.id}`).join("\n\n") + "\n\nThis authorizes an allocation. Pool settlement is a separate step."
      : `Create order: ${String(args.side)} ${String(args.quantity)} at limit price ${String(args.limitPrice)}`;
    await approveHosted("Approve testnet transaction", `${this.config.network}\nSigning party: ${this.party()}\n\n${summary}`, details);
    if (!this.key) throw new Error("Wallet disconnected before signing");
    return this.request("execute", { id: prepared.id, transactionSignature: await sign(this.key, from64(prepared.preparedTransactionHash)) });
  }
}
