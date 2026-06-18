// Registry client. Single integration point between the operator
// backend and an asset registrar's HTTP endpoints.
//
// Endpoints (matching docs/choice-context-spec.md):
//   GET  /registry/instrument-config/:id
//   GET  /registry/credentials?holder=:p
//   GET  /registry/factories/:admin
//   GET  /registry/preapprovals?receiver=:p&admin=:a
//   GET  /registry/choice-context/:admin
//
// The client owns its caches; consumers (operator backend modules)
// MUST go through the client and never call the registry HTTP API
// directly -- that's how cache invalidation stays correct.

import { TtlCache } from "./cache.js";
import {
  ChoiceContextRef,
  Credential,
  FactoryRefs,
  InstrumentConfiguration,
  Party,
  RegistryError,
  TransferPreapproval,
} from "./types.js";
import {
  validateChoiceContextRef,
  validateCredentials,
  validateFactoryRefs,
  validateInstrumentConfiguration,
  validatePreapprovals,
} from "./validate.js";

export * from "./types.js";

export interface RegistryClientConfig {
  baseUrl: string;
  authToken?: string;
  credentialsTtlMs?: number;
  choiceContextTtlMs?: number;
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
  private readonly choiceContextCache = new TtlCache<Party, ChoiceContextRef>(
    (a) => `ctx:${a}`,
  );
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
    const cfg = await this.fetchJson(
      `/registry/instrument-config/${encodeURIComponent(instrumentId)}`,
      validateInstrumentConfiguration,
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
    const refs = await this.fetchJson(
      `/registry/factories/${encodeURIComponent(admin)}`,
      validateFactoryRefs,
    );
    if (!refs) {
      throw new RegistryError("factory-stale", `admin=${admin}`, true);
    }
    this.factoryCache.set(admin, refs);
    return refs;
  }

  /**
   * Off-ledger choice context for token-standard factory choices.
   * Token-standard registries compute this (disclosed config contracts,
   * featured-app rights, …) and the caller threads it into the choice's
   * ExtraArgs. Registries that need no context may return 404; callers
   * treat that as empty context + no disclosure.
   */
  async getChoiceContext(admin: Party): Promise<ChoiceContextRef> {
    const cached = this.choiceContextCache.get(admin);
    if (cached) return cached;
    const ctx =
      (await this.fetchJson(
        `/registry/choice-context/${encodeURIComponent(admin)}`,
        validateChoiceContextRef,
      )) ?? { context: { values: {} }, disclosure: [] };
    this.choiceContextCache.set(admin, ctx, this.config.choiceContextTtlMs);
    return ctx;
  }

  async getCredentials(holder: Party): Promise<Credential[]> {
    const cached = this.credCache.get(holder);
    if (cached) return cached;
    const creds =
      (await this.fetchJson(
        `/registry/credentials?holder=${encodeURIComponent(holder)}`,
        validateCredentials,
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
      (await this.fetchJson(
        `/registry/preapprovals?receiver=${encodeURIComponent(
          receiver,
        )}&admin=${encodeURIComponent(admin)}`,
        validatePreapprovals,
      )) ?? [];
    this.preapprovalCache.set({ receiver, admin }, preapprovals);
    return preapprovals;
  }

  invalidateAll(): void {
    this.configCache.invalidateAll();
    this.factoryCache.invalidateAll();
    this.preapprovalCache.invalidateAll();
    this.choiceContextCache.invalidateAll();
    this.credCache.invalidateAll();
  }

  /**
   * Fetch + validate a registry response. `validate` turns the parsed JSON
   * into a checked `T`, throwing RegistryError("malformed", ...) on a shape
   * mismatch — registry output is never trusted via a bare `as T` cast (R-1).
   * Returns null on 404 (callers treat absent as empty/not-found).
   */
  private async fetchJson<T>(
    path: string,
    validate: (raw: unknown) => T,
  ): Promise<T | null> {
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
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (e) {
      throw new RegistryError(
        "malformed",
        `${path}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
        false,
      );
    }
    return validate(raw);
  }
}
