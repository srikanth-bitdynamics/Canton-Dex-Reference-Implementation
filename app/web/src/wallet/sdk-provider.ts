// CIP-0103 wallet provider backed by @canton-network/dapp-sdk.
// Composes commands via ./commands and delegates signing+submit to the wallet.
//
// This provider owns a private `DappSDK` instance (rather than the module
// singleton) so it can install a custom `walletPicker`: when the combined
// wallet picker (`./detection`) has already chosen a specific wallet, we route
// dapp-sdk's connect straight to it instead of popping the SDK's own picker.
// It also enumerates the wallets the SDK can reach — the configured CIP-103
// gateway plus any injected / announced browser wallets — via `listWallets()`,
// so the combined picker can show only wallets that are actually available.

import {
  DappSDK,
  RemoteAdapter,
  type StatusEvent,
  type AccountsChangedEvent,
  type Wallet,
} from "@canton-network/dapp-sdk";

import { composeCommands } from "./commands";
import type {
  DetectedWallet,
  WalletAccount,
  WalletConnectionStatus,
  WalletIntent,
  WalletProvider,
  WalletResult,
} from "./types";

/** Default CIP-103 wallet gateway (Splice LocalNet validator Amulet wallet). */
export const DEFAULT_WALLET_GATEWAY_URL = "http://localhost:3030/api/v0/dapp";
export const DEFAULT_WALLET_GATEWAY_NAME = "Canton wallet gateway";

export interface SdkProviderOptions {
  /** CIP-103 gateway rpc URL. Replaces the SDK's baked-in localhost default. */
  gatewayUrl?: string;
  /** Display name for the gateway row in the picker. */
  gatewayName?: string;
}

// Structural mirror of core-wallet-discovery's WalletPickerEntry/Result (not
// re-exported by @canton-network/dapp-sdk 1.1.0). The SDK calls our walletPicker
// with the discovered adapters and expects one back.
interface PickerEntry {
  providerId: string;
  name: string;
  type: string;
  description?: string;
  icon?: string;
  url?: string;
  reuseGlobalWalletPopup?: boolean;
}

// --- Browser CIP-103 wallet discovery ------------------------------------
//
// @canton-network/dapp-sdk 1.1.0 does not re-export its internal
// injected/announced discovery helpers, so we mirror the standard CIP-103
// browser handshake here (same shape the SDK uses internally): read the
// `window.canton` injection namespace, and dispatch `canton:requestProvider`
// then collect `canton:announceProvider` replies. Ids are prefixed `browser:`
// so they're distinct from the remote gateway.

interface InjectedWallet {
  id: string;
  name: string;
  description: string;
}

function isProviderLike(o: unknown): boolean {
  if (typeof o !== "object" || o === null) return false;
  const p = o as Record<string, unknown>;
  return (
    typeof p.request === "function" &&
    typeof p.on === "function" &&
    typeof p.emit === "function" &&
    typeof p.removeListener === "function"
  );
}

function discoverInjectedWallets(): InjectedWallet[] {
  if (typeof window === "undefined") return [];
  const out: InjectedWallet[] = [];
  const cand = (window as unknown as Record<string, unknown>)["canton"];
  if (cand == null) return out;
  if (isProviderLike(cand)) {
    out.push({
      id: "browser:canton",
      name: "canton (injected)",
      description: "Injected provider from window.canton",
    });
  } else if (typeof cand === "object") {
    for (const [key, val] of Object.entries(cand as Record<string, unknown>)) {
      if (isProviderLike(val)) {
        out.push({
          id: `browser:canton.${key}`,
          name: `canton.${key} (injected)`,
          description: `Injected provider from window.canton.${key}`,
        });
      }
    }
  }
  return out;
}

async function discoverAnnouncedWallets(): Promise<Array<{ id: string; name: string; icon?: string }>> {
  if (typeof window === "undefined") return [];
  const found = new Map<string, { id: string; name: string; icon?: string }>();
  const handler = (e: Event) => {
    const d = (e as CustomEvent).detail as
      | { id?: string; name?: string; icon?: string }
      | undefined;
    if (!d?.id || !d.name || found.has(d.id)) return;
    found.set(d.id, { id: `browser:ext:${d.id}`, name: d.name, icon: d.icon });
  };
  window.addEventListener("canton:announceProvider", handler);
  try {
    window.dispatchEvent(new CustomEvent("canton:requestProvider", { detail: {} }));
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    window.removeEventListener("canton:announceProvider", handler);
  }
  return [...found.values()];
}

// The CIP-0103 SDK / wallet gateway rejects with a structured JSON-RPC error
// object (e.g. `{ error: { message, code, cause } }`), not an Error. The dApp's
// `String(err)` then rendered "[object Object]" and hid the real failure (e.g.
// "FAILED_TO_PREPARE_TRANSACTION: Preparing multiple commands is currently not
// supported"). Extract a human-readable message from whatever shape arrives.
export function describeWalletError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const inner = (o.error && typeof o.error === "object" ? o.error : o) as Record<
      string,
      unknown
    >;
    const msg = inner.message ?? inner.cause ?? o.message ?? o.reason;
    const code = inner.code ?? o.code;
    if (typeof msg === "string") {
      return typeof code === "string" || typeof code === "number"
        ? `${code}: ${msg}`
        : msg;
    }
    try {
      return JSON.stringify(e);
    } catch {
      /* circular — fall through */
    }
  }
  return String(e);
}

export class SdkProvider implements WalletProvider {
  readonly id = "sdk" as const;
  readonly label = "Canton wallet (CIP-0103)";

  private status: WalletConnectionStatus = { kind: "disconnected" };
  private listeners = new Set<(s: WalletConnectionStatus) => void>();
  private initialised = false;
  private statusListener: ((e: StatusEvent) => void) | null = null;
  private accountsListener: ((e: AccountsChangedEvent) => void) | null = null;

  private readonly sdk: DappSDK;
  private readonly gatewayAdapter: RemoteAdapter;
  private readonly gatewayName: string;
  private readonly gatewayUrl: string;
  private readonly gatewayProviderId: string;
  // Set by connect(walletId) so the walletPicker routes to the chosen wallet
  // instead of prompting. Cleared in connect()'s finally.
  private pendingWalletId: string | null = null;

  constructor(
    private readonly packagePrefix: string,
    options: SdkProviderOptions = {},
  ) {
    this.gatewayUrl = options.gatewayUrl ?? DEFAULT_WALLET_GATEWAY_URL;
    this.gatewayName = options.gatewayName ?? DEFAULT_WALLET_GATEWAY_NAME;
    this.gatewayProviderId = `remote:${this.gatewayUrl}`;
    this.gatewayAdapter = new RemoteAdapter({
      providerId: this.gatewayProviderId,
      name: this.gatewayName,
      rpcUrl: this.gatewayUrl,
      description: "CIP-103 Splice / Amulet wallet gateway",
    });
    this.sdk = new DappSDK({
      walletPicker: (entries: PickerEntry[]) => this.pickWallet(entries),
    } as unknown as ConstructorParameters<typeof DappSDK>[0]);
  }

  private async ensureInit(): Promise<void> {
    if (this.initialised) return;
    // The configured gateway is the sole `defaultAdapters` entry, replacing the
    // SDK's baked-in localhost:3030 default. Injected / announced CIP-103
    // wallets are still discovered independently of `defaultAdapters`.
    await this.sdk.init({ defaultAdapters: [this.gatewayAdapter] });
    this.initialised = true;
  }

  // The SDK's wallet picker. When a specific wallet was requested
  // (connect(walletId)), route to exactly it; otherwise (native default flow)
  // prefer the remote gateway, then the first entry.
  private async pickWallet(entries: PickerEntry[]): Promise<PickerEntry> {
    if (this.pendingWalletId) {
      const match = entries.find((e) => e.providerId === this.pendingWalletId);
      if (match) return match;
      // The chosen wallet is no longer among the SDK's discovered adapters
      // (e.g. an injected/announced wallet that stopped responding between the
      // picker snapshot and connect). Do NOT silently fall back to the gateway
      // — that would connect a DIFFERENT wallet/party than the user picked.
      // Fail so they re-pick.
      throw new Error(
        `selected wallet "${this.pendingWalletId}" is no longer available — reopen Connect wallet and pick again`,
      );
    }
    const remote = entries.find((e) => e.type === "remote") ?? entries[0];
    if (!remote) {
      throw new Error("sdk-provider: no CIP-103 wallet available to connect");
    }
    return remote;
  }

  /** POST a CIP-103 `status` probe at the gateway to tell "gateway down" apart
   * from other failures. Throws an actionable error when unreachable. */
  private async assertGatewayReachable(): Promise<void> {
    try {
      const res = await fetch(this.gatewayUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "dex-wallet-preflight",
          method: "status",
          params: {},
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const suffix = err instanceof Error ? ` (${err.message})` : "";
      throw new Error(
        `Canton wallet gateway is not reachable at ${this.gatewayUrl}${suffix}. ` +
          "Start the wallet gateway, then retry Connect wallet.",
      );
    }
  }

  async connect(walletId?: string): Promise<WalletAccount> {
    this.setStatus({ kind: "connecting" });
    this.pendingWalletId = walletId ?? null;
    const targetIsGateway = !walletId || walletId.startsWith("remote:");
    try {
      await this.ensureInit();
      const conn = await this.sdk.connect();
      if (!conn.isConnected) {
        throw new Error(`sdk-provider: wallet refused connect (${conn.reason ?? "no reason"})`);
      }
      // SDK rejects status/account subscriptions before connect resolves.
      if (this.statusListener === null) this.wireEvents();
      const account = await this.primaryAccount();
      this.setStatus({ kind: "connected", account, providerId: this.id });
      return account;
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err);
      // The SDK's connect() retry loop assumes ITS OWN popup picker is mounted;
      // with our headless walletPicker a gateway-side failure surfaces as the
      // opaque "Wallet picker is not open" (or "not connected"). When the target
      // was the gateway, probe it so the user sees the real reason (down /
      // misconfigured) instead of a misleading picker message.
      if (targetIsGateway && /wallet picker is not open|not connected/i.test(msg)) {
        try {
          await this.assertGatewayReachable();
          msg =
            `Connected to the wallet gateway at ${this.gatewayUrl}, but no wallet ` +
            "session was established. Sign in at the gateway, then retry Connect wallet.";
        } catch (probeErr) {
          msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
        }
      }
      this.setStatus({ kind: "error", message: msg });
      // Rethrow with the clarified message so callers/logs see it too.
      throw err instanceof Error ? Object.assign(err, { message: msg }) : err;
    } finally {
      this.pendingWalletId = null;
    }
  }

  /**
   * Enumerate the wallets this provider can reach: the configured CIP-103
   * gateway (always), plus any injected (`window.canton*`) and announced
   * (browser-extension) CIP-103 wallets discovered at call time. The gateway
   * row routes exactly (its providerId is our RemoteAdapter's); injected /
   * announced rows are surfaced and best-effort routed (the SDK re-discovers
   * and connects them on pick).
   */
  async listWallets(): Promise<readonly DetectedWallet[]> {
    const out: DetectedWallet[] = [
      {
        id: `sdk:${this.gatewayProviderId}`,
        providerId: this.id,
        walletId: this.gatewayProviderId,
        name: this.gatewayName,
        description: "CIP-103 Splice / Amulet wallet gateway",
        installed: true,
        badge: "Gateway",
      },
    ];

    try {
      for (const inj of discoverInjectedWallets()) {
        out.push({
          id: `sdk:${inj.id}`,
          providerId: this.id,
          walletId: inj.id,
          name: inj.name,
          description: inj.description,
          installed: true,
          badge: "Injected",
        });
      }
    } catch {
      /* discovery unavailable (SSR / no window) — skip injected */
    }

    try {
      const announced = await discoverAnnouncedWallets();
      for (const a of announced) {
        out.push({
          id: `sdk:${a.id}`,
          providerId: this.id,
          walletId: a.id,
          name: a.name,
          icon: a.icon,
          description: "Browser extension CIP-103 wallet",
          installed: true,
          badge: "Extension",
        });
      }
    } catch {
      /* announce handshake timed out / unsupported — skip announced */
    }

    const seen = new Set<string>();
    return out.filter((e) => !seen.has(e.id) && seen.add(e.id));
  }

  async disconnect(): Promise<void> {
    try { await this.sdk.disconnect(); } catch { /* already disconnected */ }
    // Tear down the event subscriptions: the SDK drops them with its client on
    // disconnect, and connect() only re-wires when statusListener === null. Not
    // clearing them here leaves the provider deaf to status/account events after
    // a reconnect (connect → disconnect → connect).
    await this.teardownEvents();
    this.setStatus({ kind: "disconnected" });
  }

  getStatus(): WalletConnectionStatus {
    return this.status;
  }

  onStatusChange(cb: (s: WalletConnectionStatus) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async submit(intent: WalletIntent): Promise<WalletResult> {
    if (this.status.kind !== "connected") {
      throw new Error("sdk-provider: wallet not connected");
    }
    const party = this.status.account.party;
    const composed = composeCommands(intent, {
      party,
      packagePrefix: this.packagePrefix,
      now: () => new Date(),
    });
    let result: Awaited<ReturnType<DappSDK["prepareExecuteAndWait"]>>;
    try {
      result = await this.sdk.prepareExecuteAndWait({
        commandId: composed.commandId,
        commands: composed.commands as unknown as Record<string, unknown>,
        actAs: composed.actAs,
        // Off-participant factory/request contracts (AllocationFactory, the
        // AllocationRequest) the trader's participant does not host must be
        // disclosed, or the exercise fails with CONTRACT_NOT_FOUND.
        ...(composed.disclosedContracts && composed.disclosedContracts.length > 0
          ? { disclosedContracts: composed.disclosedContracts }
          : {}),
      } as Parameters<DappSDK["prepareExecuteAndWait"]>[0]);
    } catch (e) {
      // Surface the wallet/gateway's real error instead of "[object Object]".
      throw new Error(`wallet submission failed: ${describeWalletError(e)}`);
    }
    // prepareExecuteAndWait resolves to { tx: { status, commandId, payload:
    // { updateId, completionOffset } } } — it carries NO created events. So this
    // is an updateId-only provider: the operator recovers the created Allocation
    // cids (and the LP acceptance receipt) from the updateId tree for every DvP
    // flow (swap, LP add/remove, order funding), exactly like the PartyLayer
    // provider. Do NOT try to parse created cids from the result — there are none.
    const updateId = result.tx.payload.updateId;
    if (!updateId) {
      throw new Error(
        "sdk-provider: wallet returned no updateId; operator-discovery requires an updateId",
      );
    }
    return {
      submittedBy: party,
      primaryCid: updateId,
      auxiliaryCids: { updateId },
    };
  }

  private async primaryAccount(): Promise<WalletAccount> {
    const accounts: Wallet[] = await this.sdk.listAccounts();
    if (accounts.length === 0) {
      throw new Error("sdk-provider: wallet returned no accounts");
    }
    const primary = accounts.find((w) => w.primary) ?? accounts[0];
    return { party: primary.partyId, label: primary.hint || primary.partyId };
  }

  private setStatus(s: WalletConnectionStatus): void {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }

  private wireEvents(): void {
    this.statusListener = (e: StatusEvent) => {
      // The connection flag lives at e.connection.isConnected, not e.isConnected;
      // reading the wrong (always-undefined) field meant disconnect was never
      // detected and the provider stayed "connected" against a dead session.
      const conn = e.connection?.isConnected;
      if (conn === false && this.status.kind === "connected") {
        this.setStatus({ kind: "disconnected" });
      }
    };
    this.accountsListener = (e: AccountsChangedEvent) => {
      const primary = e.find((w) => w.primary) ?? e[0];
      if (!primary) return;
      if (this.status.kind === "connected" && this.status.account.party !== primary.partyId) {
        this.setStatus({
          kind: "connected",
          account: { party: primary.partyId, label: primary.hint || primary.partyId },
          providerId: this.id,
        });
      }
    };
    void this.sdk.onStatusChanged(this.statusListener);
    void this.sdk.onAccountsChanged(this.accountsListener);
  }

  async destroy(): Promise<void> {
    await this.teardownEvents();
  }

  // Remove + null both event subscriptions so the next connect() re-wires them
  // against the SDK's new client. Shared by disconnect() and destroy().
  private async teardownEvents(): Promise<void> {
    if (this.statusListener) {
      await this.sdk.removeOnStatusChanged(this.statusListener);
      this.statusListener = null;
    }
    if (this.accountsListener) {
      await this.sdk.removeOnAccountsChanged(this.accountsListener);
      this.accountsListener = null;
    }
  }
}
