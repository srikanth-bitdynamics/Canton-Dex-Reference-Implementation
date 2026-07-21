// Top-level shell:
//   - brand block on the left with version + network meta
//   - tab nav with explicit `data-screen-label` attribute for automated
//     screenshots and regression checks
//   - status pill (sync state) and wallet block on the right
//
// Wallet state is owned by `useWalletStore` and surfaced through
// `<ConnectWalletButton/>`. Trader-authority actions submit through
// `handToWallet`, which dispatches to the active provider.

import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { ConnectWalletButton } from '@/components/ConnectWalletButton';
import { ledger } from '@/services/ledger';

const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'v0.6.0';

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
        style={{ background: 'var(--bg-sunken)' }}
      >
        <div className="max-w-7xl mx-auto flex items-center gap-6 px-6 py-3">
          {/* Brand — plain-type wordmark (no logo mark exists; none invented). */}
          <div className="leading-tight">
            <div className="flex items-baseline gap-1">
              <span
                style={{
                  fontWeight: 600,
                  fontStretch: '118%',
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                }}
              >
                Canton DEX
              </span>
            </div>
            <div
              className="mono text-[10px]"
              style={{ color: 'var(--text-muted)' }}
            >
              {APP_VERSION} · {networkLabel}
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
                className="px-3 py-1.5 rounded-sm text-sm transition-colors"
                style={({ isActive }) => ({
                  color: isActive ? 'var(--accent-text)' : 'var(--text-secondary)',
                  background: isActive ? 'var(--accent-subtle)' : 'transparent',
                  fontWeight: isActive ? 500 : 400,
                })}
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
