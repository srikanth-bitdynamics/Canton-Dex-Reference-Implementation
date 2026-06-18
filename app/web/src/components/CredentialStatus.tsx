// Credential status banner.
//
// Reads the connected party's holder credentials via the operator
// backend and shows a warning if any required credential is missing
// for the instruments the user is about to interact with.
//
// Use case: before showing a trader the "Place Order" or "Swap" form,
// check whether they hold the credentials required by the relevant
// reference-registry instrument config. If not, render the banner with guidance.

import { useQuery } from '@tanstack/react-query';

interface CredentialStatusProps {
  party: string | null;
  /** Instruments the user is about to operate on (base, quote, lp...). */
  instrumentIds: string[];
  apiBase?: string;
}

interface Credential {
  issuer: string;
  holder: string;
  property: string;
  value: string;
}

interface InstrumentConfig {
  admin: string;
  instrumentId: string;
  holderRequirements: Array<{ issuer: string; property: string; value: string }>;
}

function holderHas(req: InstrumentConfig['holderRequirements'][number], creds: Credential[]): boolean {
  return creds.some(
    (c) => c.issuer === req.issuer && c.property === req.property && c.value === req.value,
  );
}

export function CredentialStatus({ party, instrumentIds, apiBase = '' }: CredentialStatusProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['credentials', party, instrumentIds.join(',')],
    enabled: !!party && instrumentIds.length > 0,
    queryFn: async () => {
      if (!party) return null;
      const [credRes, cfgRes] = await Promise.all([
        fetch(`${apiBase}/v1/credentials?holder=${encodeURIComponent(party)}`),
        fetch(`${apiBase}/v1/instruments?ids=${instrumentIds.map(encodeURIComponent).join(',')}`),
      ]);
      if (!credRes.ok || !cfgRes.ok) {
        // Soft-fail: don't break the page if the endpoint isn't available.
        return null;
      }
      const creds = (await credRes.json()) as Credential[];
      const configs = (await cfgRes.json()) as InstrumentConfig[];
      const missing: Array<{ instrumentId: string; req: InstrumentConfig['holderRequirements'][number] }> = [];
      for (const cfg of configs) {
        for (const req of cfg.holderRequirements) {
          if (!holderHas(req, creds)) {
            missing.push({ instrumentId: cfg.instrumentId, req });
          }
        }
      }
      return missing;
    },
    staleTime: 30_000,
  });

  if (!party || instrumentIds.length === 0) return null;
  if (isLoading || error || !data || data.length === 0) return null;

  return (
    <div className="mb-3 rounded border border-yellow-400 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
      <div className="font-semibold mb-1">Missing credentials</div>
      <ul className="list-disc ml-4 text-xs space-y-0.5">
        {data.map((m, i) => (
          <li key={i}>
            {m.instrumentId}: requires <code className="font-mono">{m.req.property}={m.req.value}</code>{' '}
            from issuer <code className="font-mono">{m.req.issuer}</code>
          </li>
        ))}
      </ul>
      <div className="mt-1 text-xs">Contact the relevant credential issuer to obtain these claims before trading.</div>
    </div>
  );
}
