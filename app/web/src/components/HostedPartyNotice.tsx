// Notice for a party connected through an external wallet that this
// deployment's participant does not host.
//
// The pools' counter-asset is issued by this deployment's test registry, which
// can only issue holdings to parties hosted here — so an externally hosted
// party can read every screen but cannot hold or trade that asset. External
// wallets are deliberately NOT blocked or disabled: they connect normally and
// this banner explains the limitation and offers the testnet party instead.
//
// Testnet-only, both sides: rendering is gated on VITE_ENABLE_TESTNET_PARTY=1
// and the hosting lookup it depends on only exists when the backend runs with
// DEX_TESTNET_ONBOARDING=1.

import { useQuery } from '@tanstack/react-query';

import { OperatorApi } from '@/services/operator-api';
import { useWalletStore } from '@/wallet/store';
import type { WalletProviderId } from '@/wallet/registry';

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8080';

const operator = new OperatorApi(API_BASE);

// Providers that connect a party the user brings with them. The operator relay
// and the hosted testnet party are always on this participant, so the hosting
// question does not arise for them.
const EXTERNAL_PROVIDER_IDS: WalletProviderId[] = [
  'partylayer',
  'sdk',
  'walletconnect',
];

export function HostedPartyNotice() {
  const account = useWalletStore((s) => s.account);
  const activeProviderId = useWalletStore((s) => s.activeProviderId);
  const connect = useWalletStore((s) => s.connect);

  const testnetPartyEnabled =
    (import.meta.env.VITE_ENABLE_TESTNET_PARTY ?? '') === '1';
  const party = account?.party ?? null;
  const isExternal =
    !!activeProviderId && EXTERNAL_PROVIDER_IDS.includes(activeProviderId);

  const { data } = useQuery({
    queryKey: ['testnet-hosting', party],
    queryFn: () => operator.getTestnetHosting(party as string),
    enabled: testnetPartyEnabled && isExternal && !!party,
    staleTime: 60_000,
    retry: false,
  });

  // No answer (lookup unavailable) or the party is hosted here: nothing to say.
  if (!data || data.hostedHere) return null;

  const handleCreateParty = async () => {
    try {
      await connect('testnet-hosted');
    } catch (e) {
      // The store keeps the error in `status`; the Connect button renders it.
      // eslint-disable-next-line no-console
      console.error('[testnet party]', e);
    }
  };

  return (
    <div
      role="status"
      style={{
        marginBottom: 16,
        padding: '12px 14px',
        borderRadius: 8,
        background: 'var(--bg-2)',
        border: '1px solid var(--amber, #f59e0b)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        This party is not hosted on this validator
      </div>
      <p style={{ margin: '0 0 8px', color: 'var(--text-2)' }}>
        No second Token Standard V2 asset is broadly available on this network
        yet, so this deployment issues its own test asset to pair against. That
        asset lives in this deployment&apos;s Daml package, and a party can only
        hold it if its participant has vetted that package. Your connected party
        is hosted on a participant that has not, so it can read every screen here
        but cannot hold or trade the asset.
      </p>
      <p style={{ margin: '0 0 8px', color: 'var(--text-2)' }}>
        There are two ways to trade here. Create a testnet party: a temporary,
        testnet-only demo account allocated on and signed for by this deployment.
        It is not a real self-custody wallet, it holds no assets of value, and it
        may be removed at any time. Creating one replaces your current wallet
        connection; your wallet itself is unaffected.
      </p>
      <p style={{ margin: '0 0 10px', color: 'var(--text-2)' }}>
        Or, if you run your own validator, keep the wallet you have: vet this
        deployment&apos;s <code>canton-dex-trading</code> Daml package on your own
        participant and connect your own party. Nothing here is custodial in that
        setup.
      </p>
      <button
        type="button"
        onClick={handleCreateParty}
        style={{
          padding: '6px 12px',
          borderRadius: 8,
          background: 'var(--bg-3)',
          border: '1px solid var(--border)',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        Create testnet party
      </button>
    </div>
  );
}
