// Token Standard V2 registry client. Every lookup is operation-specific and
// carries the exact Daml JSON choice argument, as required by the upstream
// allocation/allocation-instruction OpenAPI. Choice contexts are deliberately
// not cached: the standard permits them to be specific to one exercise.

import {
  ChoiceArguments,
  ChoiceContextRef,
  FactoryChoiceContextRef,
  Party,
  RegistryDiscovery,
  RegistryError,
  FactoryRefs,
} from "./types.js";
import {
  validateChoiceContextRef,
  validateFactoryChoiceContextRef,
} from "./validate.js";

export * from "./types.js";

export interface RegistryClientConfig {
  /** One registry URL, or a resolver for deployments listing several admins. */
  baseUrl: string | ((admin: Party) => string);
  authToken?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class RegistryClient implements RegistryDiscovery {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: RegistryClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getAllocationFactory(
    admin: Party,
    choiceArguments: ChoiceArguments,
  ): Promise<FactoryChoiceContextRef> {
    return this.requireJson(
      admin,
      "/registry/allocation-instruction/v2/allocation-factory",
      { choiceArguments },
      validateFactoryChoiceContextRef,
    );
  }

  async getSettlementFactory(
    admin: Party,
    choiceArguments: ChoiceArguments,
  ): Promise<FactoryChoiceContextRef> {
    return this.requireJson(
      admin,
      "/registry/allocation/v2/settlement-factory",
      { choiceArguments },
      validateFactoryChoiceContextRef,
    );
  }

  async getAllocationCancelContext(
    admin: Party,
    allocationId: string,
    meta: Record<string, string> = {},
  ): Promise<ChoiceContextRef> {
    return this.requireJson(
      admin,
      `/registry/allocations/v2/${encodeURIComponent(allocationId)}/choice-contexts/cancel`,
      { meta },
      validateChoiceContextRef,
    );
  }

  async getAllocationWithdrawContext(
    admin: Party,
    allocationId: string,
    meta: Record<string, string> = {},
  ): Promise<ChoiceContextRef> {
    return this.requireJson(
      admin,
      `/registry/allocations/v2/${encodeURIComponent(allocationId)}/choice-contexts/withdraw`,
      { meta },
      validateChoiceContextRef,
    );
  }

  /**
   * Fetch + validate a registry response. `validate` turns the parsed JSON
   * into a checked `T`, throwing RegistryError("malformed", ...) on a shape
   * mismatch. Registry output is never trusted via a bare `as T` cast.
   * A missing canonical endpoint is an integration error, not permission to
   * silently submit empty context.
   */
  private async requireJson<T>(
    admin: Party,
    path: string,
    body: Record<string, unknown>,
    validate: (raw: unknown) => T,
  ): Promise<T> {
    const baseUrl =
      typeof this.config.baseUrl === "function"
        ? this.config.baseUrl(admin)
        : this.config.baseUrl;
    // Concatenate rather than `new URL(path, baseUrl)`: an absolute `path`
    // would discard a base-URL path prefix, but registries mount these
    // endpoints under one — e.g. DA Utilities serves them at
    // `/api/token-standard/v0/registrars/<admin>`, and Splice Scan under
    // `/api/scan`. Preserving the prefix is required or every call 404s.
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.config.authToken) {
      headers.Authorization = `Bearer ${this.config.authToken}`;
    }
    const res = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 404) {
      throw new RegistryError("not-found", `${path}: admin=${admin}`, false);
    }
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

/**
 * Adapter for the repository's self-registry, whose factory CIDs are deployed
 * and configured together with the operator. It implements the same
 * operation-specific interface without exposing made-up HTTP endpoints.
 */
export class FixedRegistryClient implements RegistryDiscovery {
  constructor(
    private readonly factoriesForAdmin: (admin: Party) => FactoryRefs,
  ) {}

  async getAllocationFactory(
    admin: Party,
    _choiceArguments: ChoiceArguments,
  ): Promise<FactoryChoiceContextRef> {
    const refs = this.factoriesForAdmin(admin);
    return {
      factoryCid: refs.allocationFactoryCid,
      context: { values: {} },
      disclosure: refs.disclosure,
    };
  }

  async getSettlementFactory(
    admin: Party,
    _choiceArguments: ChoiceArguments,
  ): Promise<FactoryChoiceContextRef> {
    const refs = this.factoriesForAdmin(admin);
    return {
      factoryCid: refs.settlementFactoryCid,
      context: { values: {} },
      disclosure: refs.disclosure,
    };
  }

  async getAllocationCancelContext(
    _admin: Party,
    _allocationId: string,
    _meta: Record<string, string> = {},
  ): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: [] };
  }

  async getAllocationWithdrawContext(
    _admin: Party,
    _allocationId: string,
    _meta: Record<string, string> = {},
  ): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: [] };
  }

}
