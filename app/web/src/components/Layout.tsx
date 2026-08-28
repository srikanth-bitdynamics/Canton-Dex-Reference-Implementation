// Top-level shell:
//   - brand block on the left with version + network meta
//   - tab nav with stable screen labels
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
const DOCS_URL =
  (import.meta.env.VITE_DOCS_URL as string | undefined) ||
  'https://srikanth-bitdynamics.github.io/Canton-Dex-Reference-Implementation/';

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
  const isInMemoryPreview = status?.network === 'preview:in-memory';
  const networkLabel = isInMemoryPreview
    ? 'in-memory preview'
    : (status?.network ?? 'connecting…');
  const slotLabel = status
    ? isInMemoryPreview
      ? 'Preview · no Canton'
      : status.synced
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
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              data-screen-label="Docs"
              className="px-3 py-1.5 rounded-sm text-sm transition-colors"
              style={{ color: 'var(--text-secondary)' }}
            >
              Docs
            </a>
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
        {isInMemoryPreview && (
          <div
            role="status"
            className="mb-5 rounded-sm border px-4 py-3 text-sm"
            style={{
              background: 'var(--warning-subtle, rgba(245, 158, 11, 0.08))',
              borderColor: 'var(--warning, #d97706)',
              color: 'var(--text-secondary)',
            }}
          >
            <strong style={{ color: 'var(--text-primary)' }}>
              In-memory preview — no Canton participant.
            </strong>{' '}
            Data is seeded and wallet actions demonstrate intent composition;
            they do not settle token value.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
