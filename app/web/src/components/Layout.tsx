// Top-level shell. Layout adapted from cdex-app.jsx topbar treatment:
//   - brand block on the left with version + network meta
//   - tab nav with explicit `data-screen-label` attribute (used by
//     deck/screenshot tooling)
//   - status pill (sync state) and wallet block on the right
//
// Wallet state is owned by `useWalletStore` and surfaced through
// `<ConnectWalletButton/>`. Trader-authority actions submit through
// `handToWallet`, which dispatches to the active provider.

import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { ConnectWalletButton } from '@/components/ConnectWalletButton';
import { ledger } from '@/services/ledger';

const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'v0.6';

const NAV_ITEMS = [
  { to: '/', label: 'Trade' },
  { to: '/pools', label: 'Pools' },
  { to: '/orders', label: 'Orders' },
  { to: '/rfq', label: 'RFQ' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/admin', label: 'Admin' },
] as const;

export function Layout() {
  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: ledger.getStatus,
    refetchInterval: 5000,
  });
  const networkLabel = status?.network ?? 'connecting…';
  const slotLabel = status
    ? status.synced
      ? `Synced · slot ${status.slot.toLocaleString()}`
      : `Catching up · slot ${status.slot.toLocaleString()}`
    : 'Connecting…';

  return (
    <div className="min-h-screen bg-surface text-text-primary">
      <header
        className="border-b border-surface-border"
        style={{ background: 'var(--bg-2)' }}
      >
        <div className="max-w-7xl mx-auto flex items-center gap-6 px-6 py-3">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <span
              className="inline-block w-6 h-6 rounded-md"
              style={{
                background:
                  'linear-gradient(135deg, var(--blue), var(--green))',
              }}
            ></span>
            <div className="leading-tight">
              <div className="font-semibold text-sm">Canton DEX</div>
              <div
                className="mono text-[10px]"
                style={{ color: 'var(--text-2)' }}
              >
                {APP_VERSION} · {networkLabel}
              </div>
            </div>
          </div>

          {/* Nav */}
          <nav className="flex gap-1">
            {NAV_ITEMS.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                data-screen-label={label}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md text-sm transition-colors ${
                    isActive
                      ? 'bg-surface-hover text-text-primary font-medium'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="flex-1" />

          {/* Status + wallet */}
          <div className="status-pill" title={status?.serverTime ?? ''}>
            <span className="dot" />
            {slotLabel}
          </div>
          <ConnectWalletButton />
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
