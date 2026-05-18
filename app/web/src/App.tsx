import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '@/components/Layout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { TradePage } from '@/pages/TradePage';
import { PoolsPage } from '@/pages/PoolsPage';
import { OrdersPage } from '@/pages/OrdersPage';
import { RfqPage } from '@/pages/RfqPage';
import { PortfolioPage } from '@/pages/PortfolioPage';
import { AdminPage } from '@/pages/AdminPage';
import type { ReactNode } from 'react';

function withBoundary(label: string, child: ReactNode): ReactNode {
  return <ErrorBoundary label={label}>{child}</ErrorBoundary>;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
    },
  },
});

export function App() {
  return (
    <ErrorBoundary label="root">
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={withBoundary('trade', <TradePage />)} />
            <Route path="pools" element={withBoundary('pools', <PoolsPage />)} />
            <Route path="orders" element={withBoundary('orders', <OrdersPage />)} />
            <Route path="rfq" element={withBoundary('rfq', <RfqPage />)} />
            <Route path="portfolio" element={withBoundary('portfolio', <PortfolioPage />)} />
            <Route path="admin" element={withBoundary('admin', <AdminPage />)} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}
