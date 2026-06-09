// Policy receipt modal. Renders an operator-signed PolicyReceipt for a
// settled MatchedTrade so the trader or counterparty can audit the
// ranking that produced the trade.
//
// On-ledger: the receipt rides in MatchedTrade.policyReceipt, folded
// into SettlementInfo.meta via PolicyReceipt.daml. This modal renders
// the same fields verbatim.

import { Modal } from './Modal';
import { dealerByParty, useDealers } from './dealers';
import type { PolicyReceipt } from '@/types/contracts';

export interface PolicyReceiptTrade {
  policyCid?: string;
  tradeCid?: string;
  policyVer?: string;
  rank?: number;
  considered?: number;
  dealer?: string;
  settledAt?: string;
  /** Optional embedded receipt -- if present, takes precedence over
   *  the loose top-level fields. */
  policyReceipt?: PolicyReceipt;
}

interface Props {
  trade: PolicyReceiptTrade | null;
  onClose: () => void;
}

export function PolicyReceiptModal({ trade, onClose }: Props) {
  const { data: dealers } = useDealers();
  if (!trade) return null;
  const r = trade.policyReceipt;
  const policyCid = trade.policyCid ?? r?.signature ?? '—';
  const tradeCid = trade.tradeCid ?? '—';
  const policyVer = trade.policyVer ?? r?.policyVersion ?? '—';
  const acceptedDealer = trade.dealer ?? r?.acceptedDealer ?? '—';
  const rank = trade.rank ?? r?.acceptedRank ?? 0;
  const considered = trade.considered ?? r?.consideredCount ?? 0;
  const settledAt = trade.settledAt ?? r?.signedAt ?? '—';
  const d = dealerByParty(acceptedDealer, dealers);

  return (
    <Modal title="Policy receipt" onClose={onClose} width={580}>
      <div className="section-h" style={{ marginBottom: 6 }}>Receipt</div>
      <div
        className="mono"
        style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}
      >
        {policyCid}
      </div>

      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 14,
          marginBottom: 14,
        }}
      >
        <div className="kv" style={{ padding: '4px 0' }}>
          <span className="k">Trade</span>
          <span className="v">
            <span className="alloc-pill mono">{tradeCid}</span>
          </span>
        </div>
        <div className="kv" style={{ padding: '4px 0' }}>
          <span className="k">Policy version applied</span>
          <span className="v mono">{policyVer}</span>
        </div>
        <div className="kv" style={{ padding: '4px 0' }}>
          <span className="k">Accepted dealer</span>
          <span className="v">
            {d.name}{' '}
            <span className="mono" style={{ color: 'var(--text-2)' }}>
              {acceptedDealer}
            </span>
          </span>
        </div>
        <div className="kv" style={{ padding: '4px 0' }}>
          <span className="k">Rank at accept time</span>
          <span className="v mono">
            {rank} of {considered} considered
          </span>
        </div>
        <div className="kv" style={{ padding: '4px 0' }}>
          <span className="k">Settlement</span>
          <span className="v mono">{settledAt}</span>
        </div>
      </div>

      {r?.rankedDealers && r.rankedDealers.length > 0 && (
        <>
          <div className="section-h">Full ranking applied</div>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--text-2)' }}>
                <th className="text-left py-1 px-2">#</th>
                <th className="text-left py-1 px-2">Dealer</th>
                <th className="text-right py-1 px-2">Price</th>
                <th className="text-right py-1 px-2">Tier</th>
              </tr>
            </thead>
            <tbody>
              {r.rankedDealers.map((rd) => (
                <tr key={rd.party}>
                  <td className="py-1 px-2 mono">{rd.rank}</td>
                  <td className="py-1 px-2">
                    {dealerByParty(rd.party, dealers).name}
                  </td>
                  <td className="py-1 px-2 text-right mono">{rd.price}</td>
                  <td className="py-1 px-2 text-right">
                    <span
                      className={`badge ${
                        rd.tier === 'trusted' ? 'green' : ''
                      } tiny`}
                    >
                      {rd.tier}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div
        style={{
          fontSize: 11,
          color: 'var(--text-2)',
          lineHeight: 1.6,
          marginTop: 14,
        }}
      >
        Operator-signed attestation that the accepted quote was ranked
        according to PolicyV
        <span className="mono" style={{ color: 'var(--text)' }}>
          {policyVer.replace('v', '')}
        </span>{' '}
        at the time of accept. Inputs and ranking output are folded
        into <span className="mono">SettlementInfo.meta</span> via the{' '}
        <span className="mono">dex.policy.*</span> key prefix, so the
        receipt rides on-ledger atomically with the trade. Disclosable
        to regulators or counterparties without revealing the trade
        itself.
      </div>
    </Modal>
  );
}
