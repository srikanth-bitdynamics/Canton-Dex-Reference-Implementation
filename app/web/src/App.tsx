import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '@/components/Layout';
import { ToastProvider } from '@/primitives/ToastProvider';
import { TradePage } from '@/pages/TradePage';
import { PoolsPage } from '@/pages/PoolsPage';
import { OrdersPage } from '@/pages/OrdersPage';
import { RfqPage } from '@/pages/RfqPage';
import { PortfolioPage } from '@/pages/PortfolioPage';
import { AdminPage } from '@/pages/AdminPage';

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
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<TradePage />} />
            <Route path="pools" element={<PoolsPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="rfq" element={<RfqPage />} />
            <Route path="portfolio" element={<PortfolioPage />} />
            <Route path="admin" element={<AdminPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
