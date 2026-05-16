// Registry client. Single integration point between the operator
// backend and an asset registrar's HTTP endpoints.
//
// Endpoints (matching docs/choice-context-spec.md):
//   GET  /registry/instrument-config/:id
//   GET  /registry/credentials?holder=:p
//   GET  /registry/factories/:admin
//   GET  /registry/preapprovals?receiver=:p&admin=:a
//
// The client owns its caches; consumers (operator backend modules)
// MUST go through the client and never call the registry HTTP API
// directly -- that's how cache invalidation stays correct.

import { TtlCache } from "./cache.js";
import {
  Credential,
  FactoryRefs,
  InstrumentConfiguration,
  Party,
  RegistryError,
  TransferPreapproval,
} from "./types.js";

export * from "./types.js";

export interface RegistryClientConfig {
  baseUrl: string;
  authToken?: string;
  credentialsTtlMs?: number;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class RegistryClient {
  private readonly configCache = new TtlCache<string, InstrumentConfiguration>(
    (id) => `cfg:${id}`,
  );
  private readonly factoryCache = new TtlCache<Party, FactoryRefs>(
    (a) => `fac:${a}`,
  );
  private readonly preapprovalCache = new TtlCache<
    { receiver: Party; admin: Party },
    TransferPreapproval[]
  >((k) => `pre:${k.receiver}:${k.admin}`);
  private readonly credCache: TtlCache<Party, Credential[]>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: RegistryClientConfig) {
    this.credCache = new TtlCache<Party, Credential[]>(
      (h) => `cred:${h}`,
      config.credentialsTtlMs ?? 60_000,
    );
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getInstrumentConfig(
    instrumentId: string,
  ): Promise<InstrumentConfiguration> {
    const cached = this.configCache.get(instrumentId);
    if (cached) return cached;
    const cfg = await this.fetchJson<InstrumentConfiguration>(
      `/registry/instrument-config/${encodeURIComponent(instrumentId)}`,
    );
    if (!cfg) {
      throw new RegistryError(
        "config-not-found",
        `instrumentId=${instrumentId}`,
        false,
      );
    }
    this.configCache.set(instrumentId, cfg);
    return cfg;
  }

  async getFactories(admin: Party): Promise<FactoryRefs> {
    const cached = this.factoryCache.get(admin);
    if (cached) return cached;
    const refs = await this.fetchJson<FactoryRefs>(
      `/registry/factories/${encodeURIComponent(admin)}`,
    );
    if (!refs) {
      throw new RegistryError("factory-stale", `admin=${admin}`, true);
    }
    this.factoryCache.set(admin, refs);
    return refs;
  }

  async getCredentials(holder: Party): Promise<Credential[]> {
    const cached = this.credCache.get(holder);
    if (cached) return cached;
    const creds =
      (await this.fetchJson<Credential[]>(
        `/registry/credentials?holder=${encodeURIComponent(holder)}`,
      )) ?? [];
    this.credCache.set(holder, creds);
    return creds;
  }

  async findCredential(
    holder: Party,
    issuer: Party,
    property: string,
    value: string,
  ): Promise<Credential | undefined> {
    const creds = await this.getCredentials(holder);
    return creds.find(
      (c) => c.issuer === issuer && c.property === property && c.value === value,
    );
  }

  async getPreapprovals(
    receiver: Party,
    admin: Party,
  ): Promise<TransferPreapproval[]> {
    const cached = this.preapprovalCache.get({ receiver, admin });
    if (cached) return cached;
    const preapprovals =
      (await this.fetchJson<TransferPreapproval[]>(
        `/registry/preapprovals?receiver=${encodeURIComponent(
          receiver,
        )}&admin=${encodeURIComponent(admin)}`,
      )) ?? [];
    this.preapprovalCache.set({ receiver, admin }, preapprovals);
    return preapprovals;
  }

  invalidateAll(): void {
    this.configCache.invalidateAll();
    this.factoryCache.invalidateAll();
    this.preapprovalCache.invalidateAll();
    this.credCache.invalidateAll();
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    const url = new URL(path, this.config.baseUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.authToken) {
      headers.Authorization = `Bearer ${this.config.authToken}`;
    }
    const res = await this.fetchImpl(url.toString(), { headers });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new RegistryError("auth", `status=${res.status}`, false);
    }
    if (!res.ok) {
      throw new RegistryError(
        "transport",
        `${res.status} ${res.statusText}`,
        true,
      );
    }
    return (await res.json()) as T;
  }
}
