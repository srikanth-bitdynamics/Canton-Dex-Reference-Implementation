// Dealer registry. Direct port of cdex-data.jsx DEALERS_INIT plus the
// `dealerByParty` resolver from cdex-primitives.jsx.
//
// In production this comes from the operator backend (the operator
// publishes the whitelist + tier metadata as part of its RFQ policy
// configuration). For the dApp we keep a curated list so the RFQ page
// renders dealer names instead of raw party ids.

export interface Dealer {
  party: string;
  name: string;
  trusted: boolean;
  whitelisted: boolean;
  ms: number;
  fillRate: number;
}

export const DEALERS: Dealer[] = [
  { party: 'orca-mm::a4f',    name: 'Orca MM',      trusted: true,  whitelisted: true,  ms: 180, fillRate: 0.94 },
  { party: 'wintermute::3c1', name: 'Wintermute',   trusted: true,  whitelisted: true,  ms: 240, fillRate: 0.91 },
  { party: 'galaxy-otc::e09', name: 'Galaxy OTC',   trusted: false, whitelisted: true,  ms: 410, fillRate: 0.87 },
  { party: 'amber-grp::71d',  name: 'Amber Group',  trusted: false, whitelisted: false, ms: 320, fillRate: 0.82 },
  { party: 'jump-tr::55b',    name: 'Jump Trading', trusted: true,  whitelisted: true,  ms: 95,  fillRate: 0.96 },
];

export function dealerByParty(party: string | undefined | null): Dealer {
  const list = DEALERS;
  return (
    list.find((d) => d.party === party) ?? {
      party: party ?? '',
      name: party ? party.split('::')[0] : '—',
      trusted: false,
      whitelisted: false,
      ms: 0,
      fillRate: 0,
    }
  );
}
