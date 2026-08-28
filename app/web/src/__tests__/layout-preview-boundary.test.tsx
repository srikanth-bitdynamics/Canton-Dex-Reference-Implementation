// The seeded backend must be visually impossible to mistake for a synchronized
// Canton environment. This test pins both sides of that UI boundary.

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { Layout } from '@/components/Layout';

function renderLayout(network: string) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({
      network,
      slot: 42,
      synced: true,
      serverTime: '2026-08-27T00:00:00Z',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<div>route content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('preview boundary', () => {
  it('labels the seeded backend as non-Canton and non-settling', async () => {
    renderLayout('preview:in-memory');

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('In-memory preview — no Canton participant.');
    expect(notice).toHaveTextContent('they do not settle token value');
    expect(screen.getByText('Preview · no Canton')).toBeInTheDocument();
  });

  it('does not show the preview warning for a live network status', async () => {
    renderLayout('canton:testnet');

    expect(await screen.findByText('Synced · slot 42')).toBeInTheDocument();
    expect(screen.queryByText(/In-memory preview/)).not.toBeInTheDocument();
  });
});
