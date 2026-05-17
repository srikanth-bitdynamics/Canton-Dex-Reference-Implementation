// Page-render smoke tests. Each top-level page must render without
// crashing when wired with mocked operator-backend responses.
// We don't assert specific UI semantics — that's what e2e is for. We
// only catch "throws on mount" regressions.

import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { ReactNode } from 'react';

import { ToastProvider } from '@/primitives/ToastProvider';
import { TradePage } from '@/pages/TradePage';
import { PoolsPage } from '@/pages/PoolsPage';
import { OrdersPage } from '@/pages/OrdersPage';
import { RfqPage } from '@/pages/RfqPage';
import { PortfolioPage } from '@/pages/PortfolioPage';
import { AdminPage } from '@/pages/AdminPage';

function wrap(child: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={child} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe('page smoke tests', () => {
  it('TradePage renders without crashing', () => {
    const { container } = render(wrap(<TradePage />));
    expect(container).toBeTruthy();
  });

  it('PoolsPage renders without crashing', () => {
    const { container } = render(wrap(<PoolsPage />));
    expect(container).toBeTruthy();
  });

  it('OrdersPage renders without crashing', () => {
    const { container } = render(wrap(<OrdersPage />));
    expect(container).toBeTruthy();
  });

  it('RfqPage renders without crashing', () => {
    const { container } = render(wrap(<RfqPage />));
    expect(container).toBeTruthy();
  });

  it('PortfolioPage renders without crashing', () => {
    const { container } = render(wrap(<PortfolioPage />));
    expect(container).toBeTruthy();
  });

  it('AdminPage renders without crashing', () => {
    const { container } = render(wrap(<AdminPage />));
    expect(container).toBeTruthy();
  });
});
