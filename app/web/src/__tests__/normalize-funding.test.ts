import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Holding } from '@/types/contracts';
import type { WalletIntent, WalletResult } from '@/wallet/types';

// --- mocks ----------------------------------------------------------------
//
// normalizeSwapFunding orchestrates: read holdings -> hand split/merge intents
// to the wallet -> re-read holdings -> pick the exact funding subset. We mock
// the wallet handoff (so no real provider/network) and the wallet store (to
// drive the active provider id, which decides admin co-sign), and we feed the
// holdings ACS through a controllable queue.

const handToWalletMock =
  vi.fn<[WalletIntent], Promise<WalletResult>>();

let activeProviderId: string | null = 'token-standard';

vi.mock('@/wallet/handoff', () => ({
  handToWallet: (intent: WalletIntent) => handToWalletMock(intent),
}));

vi.mock('@/wallet/store', () => ({
  useWalletStore: {
    getState: () => ({ activeProviderId, account: null }),
  },
}));

import { normalizeSwapFunding } from '@/services/ledger';

const h = (
  contractId: string,
  amount: string,
  admin = 'dex-admin',
  instrumentId = 'BTC',
  locked = false,
): Holding => ({
  contractId,
  owner: 'alice',
  admin,
  instrumentId,
  amount: Number(amount),
  amountRaw: amount,
  locked,
});

// Queue of ACS snapshots returned by successive ledger.getHoldings() reads.
let acsQueue: Holding[][] = [];

function mockHoldings(snapshots: Holding[][]) {
  acsQueue = snapshots.slice();
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/holdings')) {
      const next = acsQueue.length > 1 ? acsQueue.shift()! : acsQueue[0] ?? [];
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = vi.fn(impl);
}

beforeEach(() => {
  handToWalletMock.mockReset();
  activeProviderId = 'token-standard';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeSwapFunding merge-then-split chain (DEX-110)', () => {
  it('chains merges using the re-queried cid when the wallet returns only updateId', async () => {
    // Three fragments, no exact subset for 0.10 -> plan is merge h2,h1 then
    // merge into h3? No: planSwapFunding merges descending until >= target.
    // 0.08 + 0.07 >= 0.10, so primary=h2(0.08), others=[h1(0.07)].
    const initial = [h('h1', '0.0700000000'), h('h2', '0.0800000000'), h('h3', '0.0100000000')];
    // After the single merge, the ledger has a new holding (h-merged = 0.15)
    // and h3 untouched; the old h1/h2 are archived.
    const afterMerge = [h('h3', '0.0100000000'), h('h-merged', '0.1500000000')];
    // After the split of h-merged into 0.10 + 0.05.
    const afterSplit = [
      h('h3', '0.0100000000'),
      h('h-exact', '0.1000000000'),
      h('h-change', '0.0500000000'),
    ];
    mockHoldings([initial, afterMerge, afterSplit]);

    // updateId-only wallet: NO createdHoldingCids surfaced.
    handToWalletMock.mockResolvedValue({
      submittedBy: 'alice',
      primaryCid: 'update-1',
      auxiliaryCids: { updateId: 'update-1' },
    });

    const cids = await normalizeSwapFunding({
      admin: 'dex-admin',
      party: 'alice',
      instrumentId: 'BTC',
      amount: '0.1000000000',
    });

    expect(cids).toEqual(['h-exact']);

    // The merge intent chained on the original primary; the split intent
    // targeted the re-resolved merged cid (NOT an archived input).
    const calls = handToWalletMock.mock.calls.map(([i]) => i);
    const merge = calls.find((c) => c.kind === 'merge-holdings');
    const split = calls.find((c) => c.kind === 'split-holding');
    expect(merge).toMatchObject({ holdingCid: 'h2', otherCid: 'h1' });
    // Crucially the split must NOT reference the archived h2 — it must use the
    // freshly resolved merged cid (DEX-110).
    expect(split).toMatchObject({ holdingCid: 'h-merged', splitAmount: '0.1000000000' });
  });
});

describe('normalizeSwapFunding admin co-sign gating (DEX-111)', () => {
  it('returns an exact subset without any split/merge when one exists', async () => {
    activeProviderId = 'partylayer'; // external wallet, cannot co-sign admin
    mockHoldings([[h('h1', '0.1000000000'), h('h2', '5.0000000000')]]);

    const cids = await normalizeSwapFunding({
      admin: 'dex-admin',
      party: 'alice',
      instrumentId: 'BTC',
      amount: '0.1000000000',
    });

    expect(cids).toEqual(['h1']);
    expect(handToWalletMock).not.toHaveBeenCalled();
  });

  it('refuses split/merge for a wallet that cannot co-sign as admin (no exact subset)', async () => {
    activeProviderId = 'partylayer';
    // Fragments cover 0.10 but no exact subset; an admin co-sign would be
    // needed to split/merge — the external wallet cannot, so we bail.
    mockHoldings([[h('h1', '0.0700000000'), h('h2', '0.0800000000')]]);

    const cids = await normalizeSwapFunding({
      admin: 'dex-admin',
      party: 'alice',
      instrumentId: 'BTC',
      amount: '0.1000000000',
    });

    expect(cids).toBeNull();
    // No split/merge attempted on the unauthorized path.
    expect(handToWalletMock).not.toHaveBeenCalled();
  });

  it('still splits/merges for the operator relay (can co-sign admin)', async () => {
    activeProviderId = 'token-standard';
    const initial = [h('big', '5.0000000000')];
    const afterSplit = [h('exact', '0.1000000000'), h('change', '4.9000000000')];
    mockHoldings([initial, afterSplit]);
    handToWalletMock.mockResolvedValue({
      submittedBy: 'alice',
      primaryCid: 'u',
      auxiliaryCids: { updateId: 'u' },
    });

    const cids = await normalizeSwapFunding({
      admin: 'dex-admin',
      party: 'alice',
      instrumentId: 'BTC',
      amount: '0.1000000000',
    });

    expect(cids).toEqual(['exact']);
    expect(handToWalletMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'split-holding' }),
    );
  });
});
