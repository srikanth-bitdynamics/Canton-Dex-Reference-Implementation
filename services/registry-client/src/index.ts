// Registry client. Single integration point between the operator
// backend and an asset registrar's HTTP endpoints.
//
// Endpoints (matching docs/guides/choice-context.md):
//   GET  /registry/factories/:admin
//   GET  /registry/choice-context/:admin
//
// The client owns its caches. Operator modules use this boundary rather than
// calling registry endpoints directly, keeping validation and invalidation in
// one place.

import { TtlCache } from "./cache.js";
import {
  ChoiceContextRef,
  FactoryRefs,
  Party,
  RegistryError,
} from "./types.js";
import {
  validateChoiceContextRef,
  validateFactoryRefs,
} from "./validate.js";

export * from "./types.js";

export interface RegistryClientConfig {
  baseUrl: string;
  authToken?: string;
  choiceContextTtlMs?: number;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class RegistryClient {
  private readonly factoryCache = new TtlCache<Party, FactoryRefs>(
    (a) => `fac:${a}`,
  );
  private readonly choiceContextCache = new TtlCache<Party, ChoiceContextRef>(
    (a) => `ctx:${a}`,
  );
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: RegistryClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
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

  invalidateAll(): void {
    this.factoryCache.invalidateAll();
    this.choiceContextCache.invalidateAll();
  }

  /**
   * Fetch + validate a registry response. `validate` turns the parsed JSON
   * into a checked `T`, throwing RegistryError("malformed", ...) on a shape
   * mismatch. Registry output is never trusted via a bare `as T` cast.
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
