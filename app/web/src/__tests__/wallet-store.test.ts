import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WalletAccount,
  WalletConnectionStatus,
  WalletProvider,
} from '@/wallet/types';

// A fake provider that tracks how many status subscriptions are currently
// live, so the store-lifecycle tests can assert there is never a listener leak.
class FakeProvider implements WalletProvider {
  readonly label: string;
  liveSubscriptions = 0;
  totalSubscriptions = 0;
  private status: WalletConnectionStatus = { kind: 'disconnected' };
  private listeners = new Set<(s: WalletConnectionStatus) => void>();
  connectBehavior: 'ok' | 'error' = 'ok';

  constructor(readonly id: string) {
    this.label = id;
  }

  private emit(s: WalletConnectionStatus) {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }

  async connect(): Promise<WalletAccount> {
    this.emit({ kind: 'connecting' });
    if (this.connectBehavior === 'error') {
      this.emit({ kind: 'error', message: 'boom' });
      throw new Error('boom');
    }
    const account = { party: `${this.id}-party` };
    this.emit({ kind: 'connected', account, providerId: this.id });
    return account;
  }

  async disconnect(): Promise<void> {
    this.emit({ kind: 'disconnected' });
  }

  getStatus(): WalletConnectionStatus {
    return this.status;
  }

  onStatusChange(cb: (s: WalletConnectionStatus) => void): () => void {
    this.listeners.add(cb);
    this.liveSubscriptions += 1;
    this.totalSubscriptions += 1;
    return () => {
      if (this.listeners.delete(cb)) this.liveSubscriptions -= 1;
    };
  }

  async submit(): Promise<never> {
    throw new Error('not used');
  }
}

const providers = new Map<string, FakeProvider>([
  ['mock', new FakeProvider('mock')],
  ['walletconnect', new FakeProvider('walletconnect')],
]);

vi.mock('@/wallet/registry', () => ({
  getProvider: (id: string) => {
    const p = providers.get(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    return p;
  },
  getProviders: () => providers,
}));

import { useWalletStore } from '@/wallet/store';

beforeEach(async () => {
  // Clear any module-level active subscription left by a previous test before
  // we zero the counters, otherwise a stale unsubscribe could decrement a
  // freshly-reset count.
  await useWalletStore.getState().disconnect();
  for (const p of providers.values()) {
    p.liveSubscriptions = 0;
    p.totalSubscriptions = 0;
    p.connectBehavior = 'ok';
  }
  useWalletStore.setState({
    activeProviderId: null,
    status: { kind: 'disconnected' },
    account: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wallet store lifecycle', () => {
  it('keeps exactly one live subscription after repeated connects to the same provider', async () => {
    const mock = providers.get('mock')!;
    await useWalletStore.getState().connect('mock');
    await useWalletStore.getState().connect('mock');
    await useWalletStore.getState().connect('mock');

    expect(mock.liveSubscriptions).toBe(1);
    expect(useWalletStore.getState().status.kind).toBe('connected');
  });

  it('unsubscribes the previous provider when switching providers', async () => {
    const mock = providers.get('mock')!;
    const wc = providers.get('walletconnect')!;
    await useWalletStore.getState().connect('mock');
    await useWalletStore.getState().connect('walletconnect');

    expect(mock.liveSubscriptions).toBe(0);
    expect(wc.liveSubscriptions).toBe(1);
  });

  it('drops the subscription on a failed connect (error status)', async () => {
    const mock = providers.get('mock')!;
    mock.connectBehavior = 'error';
    await expect(
      useWalletStore.getState().connect('mock'),
    ).rejects.toThrow('boom');

    expect(mock.liveSubscriptions).toBe(0);
    expect(useWalletStore.getState().activeProviderId).toBeNull();
  });

  it('does not leak across error -> retry -> success', async () => {
    const mock = providers.get('mock')!;
    mock.connectBehavior = 'error';
    await expect(
      useWalletStore.getState().connect('mock'),
    ).rejects.toThrow();
    mock.connectBehavior = 'ok';
    await useWalletStore.getState().connect('mock');

    expect(mock.liveSubscriptions).toBe(1);
  });

  it('unsubscribes on disconnect', async () => {
    const mock = providers.get('mock')!;
    await useWalletStore.getState().connect('mock');
    await useWalletStore.getState().disconnect();

    expect(mock.liveSubscriptions).toBe(0);
    expect(useWalletStore.getState().status.kind).toBe('disconnected');
  });
});
