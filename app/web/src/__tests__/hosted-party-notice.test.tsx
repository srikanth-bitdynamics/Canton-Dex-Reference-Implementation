// The not-hosted-here notice: it must appear for an externally connected party
// the participant does not host, and stay out of the way otherwise.

import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { HostedPartyNotice } from '@/components/HostedPartyNotice';
import { useWalletStore } from '@/wallet/store';
import type { WalletProviderId } from '@/wallet/registry';

function wrap(child: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return <QueryClientProvider client={qc}>{child}</QueryClientProvider>;
}

function connectAs(providerId: WalletProviderId, party: string) {
  const account = { party };
  useWalletStore.setState({
    activeProviderId: providerId,
    account,
    status: { kind: 'connected', account, providerId },
  });
}

function hostingResponse(hostedHere: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/v1/testnet/hosting')
      ? new Response(JSON.stringify({ hostedHere }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      : new Response('{}', { status: 200 }),
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_ENABLE_TESTNET_PARTY', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  useWalletStore.setState({
    activeProviderId: null,
    account: null,
    status: { kind: 'disconnected' },
  });
});

describe('HostedPartyNotice', () => {
  it('renders for an external party this participant does not host', async () => {
    hostingResponse(false);
    connectAs('partylayer', 'alice::1220a');

    render(wrap(<HostedPartyNotice />));

    expect(
      await screen.findByText(/not hosted on this validator/i),
    ).toBeInTheDocument();
    // The copy must give the reason (no second V2 asset -> own asset -> the
    // participant must have vetted the package), both routes out, and the
    // temporary, non-custodial nature of the hosted offer.
    expect(screen.getByText(/Token Standard V2/i)).toBeInTheDocument();
    expect(screen.getByText(/vetted that package/i)).toBeInTheDocument();
    expect(screen.getByText(/not a real self-custody wallet/i)).toBeInTheDocument();
    // The integrator route: vet the package on your own validator.
    expect(screen.getByText(/run your own validator/i)).toBeInTheDocument();
    expect(screen.getByText(/canton-dex-trading/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /create testnet party/i }),
    ).toBeInTheDocument();
  });

  it('renders nothing for a party this participant hosts', async () => {
    hostingResponse(true);
    connectAs('partylayer', 'alice::1220a');

    const { container } = render(wrap(<HostedPartyNotice />));

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/testnet/hosting'),
      ),
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/not hosted on this validator/i)).toBeNull();
  });

  it('does not query hosting for the hosted testnet party itself', async () => {
    hostingResponse(false);
    connectAs('testnet-hosted', 'demo::1220a');

    const { container } = render(wrap(<HostedPartyNotice />));

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('stays hidden when testnet onboarding is disabled', async () => {
    vi.stubEnv('VITE_ENABLE_TESTNET_PARTY', '');
    hostingResponse(false);
    connectAs('partylayer', 'alice::1220a');

    const { container } = render(wrap(<HostedPartyNotice />));

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
