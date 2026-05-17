// RFQ page — bilateral block trades (Workflow 2 / MatchedTrade).
//
// Direct port of `cdex-rfq.jsx` from the static prototype:
//   - full-width active list with expand-in-place detail
//   - operator policy-driven quote ranking with sort-mode comparison
//   - compose-modal for new RFQs (dealer whitelist, validity window)
//   - settled tab with policy-receipt drill-down
//   - expired tab populated by the 1Hz sweeper
//   - 5-stage lifecycle bar (Open → Quoted → Accepted → Settling → Settled)
//
// Live data path:
//   - /v1/rfq seeds rfqs/quotes via react-query (10s refetch)
//   - compose POSTs /v1/rfq, cancel POSTs /v1/rfq/:cid/cancel
//   - accept POSTs /v1/rfq/accept and lifts the returned receipt
//
// The 1Hz sweeper still runs locally for snappy expiry UX; the periodic
// refetch is the source of truth.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Modal } from '@/primitives/Modal';
import { PolicyReceiptModal } from '@/primitives/PolicyReceiptModal';
import { dealerByParty, DEALERS } from '@/primitives/dealers';
import { fmt, fmtUsd, fmtUsdK, formatExpiresIn } from '@/primitives/format';
import { OperatorApi } from '@/services/operator-api';
import { adaptRfqs } from '@/services/rfq-adapter';
import { rankQuotes, whitelistedDealers } from '@/services/rfq-policy';
import { ledger } from '@/services/ledger';
import { useCurrentParty } from '@/wallet/hooks';
import type {
  ExpiredRfq,
  Rfq,
  RfqQuote,
  RfqSide,
  SettledTrade,
} from '@/types/rfq';

const operatorApi = new OperatorApi(
  (import.meta.env.VITE_API_BASE as string | undefined) ??
    'http://localhost:8080',
);

type Tab = 'active' | 'settled' | 'expired';
type SortMode = 'policy' | 'price' | 'earliest' | 'trusted';

export function RfqPage() {
  const party = useCurrentParty();
  const { data: context } = useQuery({
    queryKey: ['context'],
    queryFn: ledger.getContext,
  });
  const live = useQuery({
    queryKey: ['rfqs'],
    queryFn: () => operatorApi.listRfqs(),
    refetchInterval: 10_000,
  });
  const liveRfqs = useMemo<Rfq[]>(
    () =>
      live.data ? adaptRfqs(live.data.rfqs, live.data.quotes) : [],
    [live.data],
  );

  const [rfqs, setRfqs] = useState<Rfq[]>([]);
  const [settled, setSettled] = useState<SettledTrade[]>([]);
  const [expired, setExpired] = useState<ExpiredRfq[]>([]);

  // Reconcile the live snapshot into local state. Local state holds
  // optimistic transitions (Settling/Settled flashes) that the server
  // doesn't model directly; the snapshot is authoritative for everything
  // else.
  useEffect(() => {
    if (!live.data) return;
    setRfqs((cur) => {
      const transient = new Map(
        cur
          .filter(
            (r) =>
              r.status === 'RFQ_Settling' || r.status === 'RFQ_Settled',
          )
          .map((r) => [r.contractId, r]),
      );
      return liveRfqs.map((r) => transient.get(r.contractId) ?? r);
    });
  }, [live.data, liveRfqs]);

  const [tab, setTab] = useState<Tab>('active');
  const [sortBy, setSortBy] = useState<SortMode>('policy');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [policyOpenFor, setPolicyOpenFor] = useState<string | null>(null);
  const [receiptOpenFor, setReceiptOpenFor] = useState<string | null>(null);

  // Default-expand the first RFQ once the first snapshot arrives.
  useEffect(() => {
    if (expandedId === null && rfqs.length > 0) {
      setExpandedId(rfqs[0]!.contractId);
    }
  }, [rfqs, expandedId]);

  // 1s tick: decrement expiresIn on RFQs and validFor on quotes; sweep
  // zero-expiry RFQs into Expired. Settling/Settled rows are exempt.
  useEffect(() => {
    const id = setInterval(() => {
      setRfqs((cur) => {
        const next = cur.map((r) => {
          if (r.status === 'RFQ_Settling' || r.status === 'RFQ_Settled') return r;
          return {
            ...r,
            expiresIn: Math.max(0, r.expiresIn - 1),
            quotes: r.quotes.map((q) => ({
              ...q,
              validFor: Math.max(0, q.validFor - 1),
            })),
          };
        });
        const toExpire = next.filter(
          (r) =>
            r.expiresIn === 0 &&
            r.status !== 'RFQ_Settling' &&
            r.status !== 'RFQ_Settled',
        );
        if (toExpire.length) {
          setExpired((cx) => [
            ...toExpire.map<ExpiredRfq>((r) => ({
              id: r.contractId,
              pair: r.pair,
              side: r.side,
              size: r.size,
              expiredAt: 'just now',
              whitelist: r.whitelist,
              quoteCount: r.quotes.length,
              bestPrice: r.quotes.length
                ? rankQuotes(r.side, r.quotes, 'price')[0]?.price ?? null
                : null,
              reason: r.quotes.length
                ? 'No accept before window'
                : 'No quotes received',
            })),
            ...cx,
          ]);
        }
        return next.filter(
          (r) =>
            r.expiresIn > 0 ||
            r.status === 'RFQ_Settling' ||
            r.status === 'RFQ_Settled',
        );
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const acceptQuote = useCallback(
    async (rfq: Rfq, quote: RfqQuote) => {
      if (!context) {
        console.error('rfq.accept blocked: dApp context not loaded');
        return;
      }
      const ranked = rankQuotes(rfq.side, rfq.quotes, 'policy');
      const rank = ranked.findIndex((x) => x.dealer === quote.dealer) + 1;
      setRfqs((cur) =>
        cur.map((r) =>
          r.contractId === rfq.contractId
            ? {
                ...r,
                status: 'RFQ_Settling',
                acceptedDealer: quote.dealer,
                acceptedRank: rank,
                acceptedConsidered: ranked.length,
              }
            : r,
        ),
      );

      try {
        const result = await operatorApi.acceptRfq({
          rfqCid: rfq.contractId,
          acceptedQuoteCid: quote.contractId,
          consideredQuoteCids: rfq.quotes.map((q) => q.contractId),
          admin: context.admin,
          now: new Date().toISOString(),
        });
        const settledTrade: SettledTrade = {
          id: result.tradeCid,
          pair: rfq.pair,
          side: rfq.side,
          size: rfq.size,
          price: quote.price,
          dealer: quote.dealer,
          settledAt: 'just now',
          tradeCid: result.tradeCid,
          policyVer: result.receipt.policyVersion,
          policyCid: result.receipt.policyHash.slice(0, 24),
          rank,
          considered: ranked.length,
          receipt: result.receipt,
        };
        setRfqs((cur) =>
          cur.map((r) =>
            r.contractId === rfq.contractId
              ? { ...r, status: 'RFQ_Settled', settledTrade }
              : r,
          ),
        );
        setTimeout(() => {
          setRfqs((cur) => cur.filter((r) => r.contractId !== rfq.contractId));
          setSettled((cx) => [settledTrade, ...cx]);
          live.refetch();
        }, 700);
      } catch (err) {
        console.error('rfq.accept failed', err);
        // Roll back the optimistic transition.
        setRfqs((cur) =>
          cur.map((r) =>
            r.contractId === rfq.contractId
              ? {
                  ...r,
                  status: r.quotes.length > 0 ? 'RFQ_Quoted' : 'RFQ_Open',
                  acceptedDealer: undefined,
                  acceptedRank: undefined,
                  acceptedConsidered: undefined,
                }
              : r,
          ),
        );
      }
    },
    [live],
  );

  const cancelRfq = useCallback(
    async (rfqCid: string) => {
      setRfqs((cur) => cur.filter((r) => r.contractId !== rfqCid));
      try {
        await operatorApi.cancelRfq(rfqCid);
      } finally {
        live.refetch();
      }
    },
    [live, context],
  );

  const onCompose = useCallback(
    async (rfq: Rfq) => {
      if (!party) {
        console.error('rfq.create blocked: no wallet connected');
        return;
      }
      try {
        const nowMs = Date.now();
        const expiresAt = new Date(nowMs + rfq.expiresIn * 1000).toISOString();
        const created = await operatorApi.createRfq({
          // Trader identity is the connected wallet party, NOT the
          // dealer display string the form happens to show.
          trader: party,
          rfqId: rfq.rfqId,
          pair: rfq.pair,
          side: rfq.side,
          size: rfq.size.toString(),
          expiresAt,
          whitelist: rfq.whitelist,
          createdAt: new Date(nowMs).toISOString(),
        });
        // Optimistically add with the server-assigned cid; the next
        // refetch will reconcile. NO local-only fallback — if the
        // create fails we surface the error and the user sees no
        // phantom row.
        setRfqs((cur) => [
          { ...rfq, trader: party, contractId: created.rfqCid },
          ...cur,
        ]);
        setExpandedId(created.rfqCid);
      } catch (err) {
        console.error('rfq.create failed', err);
        // Re-throw so the compose modal can surface the error. The
        // RFQ is NOT inserted locally — that would lie about ledger
        // state.
        throw err;
      } finally {
        setComposing(false);
        live.refetch();
      }
    },
    [live, party],
  );

  const totalNotional = useMemo(
    () => settled.reduce((s, t) => s + t.price * t.size, 0),
    [settled],
  );

  const settledTradeFor = useCallback(
    (id: string) => settled.find((t) => t.id === id) ?? null,
    [settled],
  );

  const policyTargetRfq = useMemo(
    () => rfqs.find((r) => r.contractId === policyOpenFor) ?? null,
    [rfqs, policyOpenFor],
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">RFQ</h2>
          <p className="page-sub">
            Bilateral block trades · Workflow 2 (MatchedTrade)
          </p>
        </div>
        <button
          className="btn primary"
          onClick={() => setComposing(true)}
          disabled={!party}
          title={!party ? 'Connect a wallet to compose an RFQ' : undefined}
        >
          + New RFQ
        </button>
      </div>

      {/* Stat strip */}
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="stat-l">Active RFQs</div>
          <div className="stat-v">{rfqs.length}</div>
          <div className="stat-d">
            {rfqs.reduce((s, r) => s + r.quotes.length, 0)} quotes inbound
          </div>
        </div>
        <div className="stat">
          <div className="stat-l">Settled (30d)</div>
          <div className="stat-v">{settled.length}</div>
          <div className="stat-d">{fmtUsdK(totalNotional)} notional</div>
        </div>
        <div className="stat">
          <div className="stat-l">Whitelisted dealers</div>
          <div className="stat-v">
            {DEALERS.filter((d) => d.whitelisted).length}
          </div>
          <div className="stat-d">of {DEALERS.length} known</div>
        </div>
        <div className="stat">
          <div className="stat-l">Avg fill rate</div>
          <div className="stat-v">94%</div>
          <div className="stat-d up">+2.1% vs last week</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="tabs" style={{ width: 380 }}>
            <button
              className={tab === 'active' ? 'active' : ''}
              onClick={() => setTab('active')}
            >
              Active · {rfqs.length}
            </button>
            <button
              className={tab === 'settled' ? 'active' : ''}
              onClick={() => setTab('settled')}
            >
              Settled · {settled.length}
            </button>
            <button
              className={tab === 'expired' ? 'active' : ''}
              onClick={() => setTab('expired')}
            >
              Expired · {expired.length}
            </button>
          </div>
          {tab === 'active' && (
            <div className="row" style={{ gap: 8, fontSize: 11, color: 'var(--text-2)' }}>
              <span>Rank quotes by:</span>
              <div className="tabs" style={{ width: 360 }}>
                {(
                  [
                    { id: 'policy', l: 'Operator policy' },
                    { id: 'price', l: 'Best price' },
                    { id: 'earliest', l: 'Earliest' },
                    { id: 'trusted', l: 'Trusted only' },
                  ] as { id: SortMode; l: string }[]
                ).map((t) => (
                  <button
                    key={t.id}
                    className={sortBy === t.id ? 'active' : ''}
                    onClick={() => setSortBy(t.id)}
                  >
                    {t.l}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {tab === 'active' && (
          <ActiveTab
            rfqs={rfqs}
            sortBy={sortBy}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            onAccept={acceptQuote}
            onCancelRfq={cancelRfq}
            onPolicyOpen={(id) => setPolicyOpenFor(id)}
            onComposeFirst={() => setComposing(true)}
          />
        )}
        {tab === 'settled' && (
          <SettledTab
            settled={settled}
            onReceiptOpen={(id) => setReceiptOpenFor(id)}
          />
        )}
        {tab === 'expired' && <ExpiredTab expired={expired} />}
      </div>

      {composing && party && context && (
        <ComposeRfqSheet
          trader={party}
          operator={context.operator}
          onClose={() => setComposing(false)}
          onSubmit={onCompose}
        />
      )}

      {policyOpenFor && policyTargetRfq && (
        <PolicyModal
          rfq={policyTargetRfq}
          onClose={() => setPolicyOpenFor(null)}
        />
      )}

      {receiptOpenFor && (
        <PolicyReceiptModal
          trade={settledTradeFor(receiptOpenFor)}
          onClose={() => setReceiptOpenFor(null)}
        />
      )}
    </div>
  );
}

// === Active tab ============================================================

interface ActiveTabProps {
  rfqs: Rfq[];
  sortBy: SortMode;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  onAccept: (rfq: Rfq, quote: RfqQuote) => void;
  onCancelRfq: (id: string) => void;
  onPolicyOpen: (id: string) => void;
  onComposeFirst: () => void;
}

function ActiveTab({
  rfqs,
  sortBy,
  expandedId,
  setExpandedId,
  onAccept,
  onCancelRfq,
  onPolicyOpen,
  onComposeFirst,
}: ActiveTabProps) {
  if (rfqs.length === 0) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-2)' }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>No active RFQs</div>
        <button className="btn primary tiny" onClick={onComposeFirst}>
          Compose your first RFQ
        </button>
      </div>
    );
  }
  return (
    <div>
      {rfqs.map((r) => (
        <RfqRow
          key={r.contractId}
          r={r}
          sortBy={sortBy}
          isExpanded={expandedId === r.contractId}
          onToggle={() =>
            setExpandedId(expandedId === r.contractId ? null : r.contractId)
          }
          onAccept={(q) => onAccept(r, q)}
          onCancelRfq={() => onCancelRfq(r.contractId)}
          onPolicyOpen={() => onPolicyOpen(r.contractId)}
        />
      ))}
    </div>
  );
}

interface RfqRowProps {
  r: Rfq;
  sortBy: SortMode;
  isExpanded: boolean;
  onToggle: () => void;
  onAccept: (q: RfqQuote) => void;
  onCancelRfq: () => void;
  onPolicyOpen: () => void;
}

function RfqRow({
  r,
  sortBy,
  isExpanded,
  onToggle,
  onAccept,
  onCancelRfq,
  onPolicyOpen,
}: RfqRowProps) {
  const lifecycle =
    r.status === 'RFQ_Open'
      ? 0
      : r.status === 'RFQ_Quoted'
        ? 1
        : r.status === 'RFQ_Accepted'
          ? 2
          : r.status === 'RFQ_Settling'
            ? 3
            : 4;
  const ranked = rankQuotes(r.side, r.quotes, sortBy);
  const best = ranked[0];

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={{
          display: 'grid',
          gridTemplateColumns: '24px 80px 1.6fr 1.4fr 1.6fr 1.4fr 1fr 110px',
          gap: 16,
          alignItems: 'center',
          width: '100%',
          padding: '14px 18px',
          background: isExpanded ? 'var(--bg-3)' : 'transparent',
          borderLeft: isExpanded
            ? '2px solid var(--blue)'
            : '2px solid transparent',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        <span
          style={{
            color: 'var(--text-2)',
            fontSize: 12,
            transform: isExpanded ? 'rotate(90deg)' : 'none',
            transition: 'transform .15s',
          }}
        >
          ›
        </span>
        <span className={`badge ${r.side === 'RFQ_Buy' ? 'green' : 'red'}`}>
          {r.side === 'RFQ_Buy' ? 'BUY' : 'SELL'}
        </span>
        <div>
          <div className="mono" style={{ fontWeight: 600 }}>
            {fmt(r.size, 4)} {r.pair.split('/')[0]}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
            {r.pair} · {r.contractId}
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-2)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Best quote
          </div>
          <div
            className="mono"
            style={{
              fontSize: 13,
              color: best
                ? r.side === 'RFQ_Buy'
                  ? 'var(--green)'
                  : 'var(--red)'
                : 'var(--text-2)',
            }}
          >
            {best ? fmt(best.price, 2) : '—'}
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-2)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Quotes
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className="mono" style={{ fontSize: 13 }}>
              {r.quotes.length}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
              of {r.whitelist.length} dealers
            </span>
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-2)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Lifecycle
          </div>
          <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
            {['Open', 'Quoted', 'Accepted', 'Settling', 'Settled'].map((s, i) => (
              <span
                key={s}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background:
                    i <= lifecycle ? 'var(--blue)' : 'var(--border)',
                }}
              ></span>
            ))}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 3 }}>
            {r.status.replace('RFQ_', '')}
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-2)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Expires
          </div>
          <div
            className="mono"
            style={{
              fontSize: 12,
              color: r.expiresIn < 60 ? 'var(--red)' : 'var(--text)',
            }}
          >
            {r.status === 'RFQ_Settling' || r.status === 'RFQ_Settled'
              ? '—'
              : formatExpiresIn(r.expiresIn)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {r.status === 'RFQ_Settling' ? (
            <span className="badge blue tiny">Settling</span>
          ) : r.status === 'RFQ_Settled' ? (
            <span className="badge green tiny">Settled</span>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
              {isExpanded ? 'Collapse' : 'Review'}
            </span>
          )}
        </div>
      </div>

      {isExpanded && (
        <div
          style={{
            background: 'var(--bg-2)',
            padding: '16px 18px 20px 44px',
            borderLeft: '2px solid var(--blue)',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 24,
              fontSize: 11,
              color: 'var(--text-2)',
              marginBottom: 14,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <span>
              Created{' '}
              <span className="mono" style={{ color: 'var(--text)' }}>
                {r.createdAt}
              </span>
            </span>
            <span>
              Whitelist{' '}
              <span className="mono" style={{ color: 'var(--text)' }}>
                {r.whitelist.length} dealers
              </span>
            </span>
            <span>
              Notional ≈{' '}
              <span className="mono" style={{ color: 'var(--text)' }}>
                {best ? fmtUsd(best.price * r.size) : '—'}
              </span>
            </span>
            <button className="btn tiny ghost" onClick={onPolicyOpen}>
              Operator policy
            </button>
          </div>

          <table className="w-full text-xs" style={{ marginBottom: 0 }}>
            <thead>
              <tr style={{ color: 'var(--text-2)' }}>
                <th className="text-left py-1 px-2" style={{ width: 24 }}></th>
                <th className="text-left py-1 px-2">Dealer</th>
                <th className="text-right py-1 px-2">Price</th>
                <th className="text-right py-1 px-2">Spread vs best</th>
                <th className="text-right py-1 px-2">Notional</th>
                <th className="text-right py-1 px-2">Posted</th>
                <th className="text-right py-1 px-2">Valid for</th>
                <th className="text-right py-1 px-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((q, i) => {
                const dealer = dealerByParty(q.dealer);
                const notional = q.price * r.size;
                const isBest = i === 0;
                const accepted = r.acceptedDealer === q.dealer;
                const otherAccepted = r.acceptedDealer && !accepted;
                const spread = best
                  ? ((q.price - best.price) / best.price) * 10000
                  : 0;
                return (
                  <tr
                    key={q.dealer}
                    style={{
                      background: accepted
                        ? 'rgba(56,139,253,0.10)'
                        : isBest
                          ? 'rgba(63,185,80,0.05)'
                          : 'transparent',
                      opacity: otherAccepted ? 0.45 : 1,
                    }}
                  >
                    <td className="py-1 px-2">
                      {isBest && (
                        <span
                          className="badge tiny green"
                          style={{ padding: '2px 6px' }}
                        >
                          Top
                        </span>
                      )}
                    </td>
                    <td className="py-1 px-2">
                      <div className="row" style={{ gap: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>
                          {dealer.name}
                        </span>
                        {dealer.trusted && (
                          <span className="badge tiny green">trusted</span>
                        )}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10, color: 'var(--text-2)' }}
                      >
                        {q.dealer}
                      </div>
                    </td>
                    <td
                      className="text-right py-1 px-2 mono"
                      style={{ fontWeight: isBest ? 600 : 400 }}
                    >
                      {fmt(q.price, 2)}
                    </td>
                    <td
                      className="text-right py-1 px-2 mono"
                      style={{ color: 'var(--text-2)', fontSize: 11 }}
                    >
                      {isBest
                        ? '—'
                        : (spread >= 0 ? '+' : '') + spread.toFixed(1) + ' bps'}
                    </td>
                    <td
                      className="text-right py-1 px-2 mono"
                      style={{ color: 'var(--text-2)' }}
                    >
                      {fmtUsd(notional)}
                    </td>
                    <td
                      className="text-right py-1 px-2 mono"
                      style={{ fontSize: 11, color: 'var(--text-2)' }}
                    >
                      {q.postedAt}
                    </td>
                    <td className="text-right py-1 px-2 mono">
                      <span
                        style={{
                          color:
                            q.validFor < 10
                              ? 'var(--red)'
                              : q.validFor < 20
                                ? 'var(--orange)'
                                : 'var(--text-2)',
                        }}
                      >
                        {q.validFor}s
                      </span>
                    </td>
                    <td className="text-right py-1 px-2">
                      {accepted ? (
                        <span className="badge blue tiny">Accepted</span>
                      ) : otherAccepted ? (
                        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
                          —
                        </span>
                      ) : (
                        <button
                          className={`btn tiny ${isBest ? 'primary' : 'ghost'}`}
                          onClick={() => onAccept(q)}
                        >
                          Accept
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {ranked.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    style={{
                      textAlign: 'center',
                      padding: 20,
                      color: 'var(--text-2)',
                      fontSize: 12,
                    }}
                  >
                    Waiting for dealers to respond…
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {r.status === 'RFQ_Settling' && (
            <div
              style={{
                marginTop: 14,
                padding: 12,
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
              }}
            >
              <div
                className="row"
                style={{ justifyContent: 'space-between', marginBottom: 6 }}
              >
                <div className="row" style={{ gap: 8 }}>
                  <span
                    className="phase-dot"
                    style={{ background: 'var(--blue)' }}
                  ></span>
                  <span style={{ fontWeight: 600 }}>MatchedTrade in flight</span>
                </div>
                <span className="alloc-pill mono">
                  PolicyV1.4 · rank {r.acceptedRank}/{r.acceptedConsidered}
                </span>
              </div>
              <div style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
                Both parties post Allocations · operator validates whitelist +
                expiry · SettleBatch executes on the two allocations atomically.
              </div>
            </div>
          )}

          {r.status !== 'RFQ_Settling' && r.status !== 'RFQ_Settled' && (
            <div
              className="row"
              style={{ justifyContent: 'flex-end', marginTop: 12, gap: 8 }}
            >
              <button className="btn ghost tiny" onClick={onCancelRfq}>
                Cancel RFQ
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// === Settled tab ===========================================================

interface SettledTabProps {
  settled: SettledTrade[];
  onReceiptOpen: (id: string) => void;
}

function SettledTab({ settled, onReceiptOpen }: SettledTabProps) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr style={{ color: 'var(--text-2)' }}>
          <th className="text-left py-2 px-3">Time</th>
          <th className="text-left py-2 px-3">Pair</th>
          <th className="text-left py-2 px-3">Side</th>
          <th className="text-right py-2 px-3">Size</th>
          <th className="text-right py-2 px-3">Price</th>
          <th className="text-right py-2 px-3">Notional</th>
          <th className="text-left py-2 px-3">Counterparty</th>
          <th className="text-right py-2 px-3">Trade CID</th>
          <th className="text-right py-2 px-3">Policy receipt</th>
        </tr>
      </thead>
      <tbody>
        {settled.map((t) => (
          <tr key={t.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
            <td
              className="py-2 px-3 mono"
              style={{ color: 'var(--text-2)', fontSize: 11 }}
            >
              {t.settledAt}
            </td>
            <td className="py-2 px-3" style={{ fontWeight: 600 }}>
              {t.pair}
            </td>
            <td className="py-2 px-3">
              <span
                className={`badge ${t.side === 'RFQ_Buy' ? 'green' : 'red'} tiny`}
              >
                {t.side === 'RFQ_Buy' ? 'BUY' : 'SELL'}
              </span>
            </td>
            <td className="text-right py-2 px-3 mono">
              {fmt(t.size, 4)} {t.pair.split('/')[0]}
            </td>
            <td className="text-right py-2 px-3 mono">{fmt(t.price, 2)}</td>
            <td
              className="text-right py-2 px-3 mono"
              style={{ color: 'var(--text-2)' }}
            >
              {fmtUsd(t.price * t.size)}
            </td>
            <td className="py-2 px-3">
              <div style={{ fontSize: 12 }}>{dealerByParty(t.dealer).name}</div>
              <div
                className="mono"
                style={{ fontSize: 10, color: 'var(--text-2)' }}
              >
                {t.dealer}
              </div>
            </td>
            <td className="text-right py-2 px-3">
              <span className="alloc-pill mono">{t.tradeCid}</span>
            </td>
            <td className="text-right py-2 px-3">
              <button
                className="alloc-pill mono"
                style={{
                  cursor: 'pointer',
                  border: 0,
                  background: 'rgba(56,139,253,0.12)',
                  color: 'var(--blue)',
                }}
                onClick={() => onReceiptOpen(t.id)}
              >
                {t.policyCid}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// === Expired tab ===========================================================

function ExpiredTab({ expired }: { expired: ExpiredRfq[] }) {
  if (expired.length === 0) {
    return (
      <div
        style={{
          textAlign: 'center',
          padding: 32,
          color: 'var(--text-2)',
          fontSize: 12,
        }}
      >
        No expired RFQs.
      </div>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr style={{ color: 'var(--text-2)' }}>
          <th className="text-left py-2 px-3">Time</th>
          <th className="text-left py-2 px-3">Pair</th>
          <th className="text-left py-2 px-3">Side</th>
          <th className="text-right py-2 px-3">Size</th>
          <th className="text-right py-2 px-3">Best quote received</th>
          <th className="text-right py-2 px-3">Quotes</th>
          <th className="text-left py-2 px-3">Reason</th>
        </tr>
      </thead>
      <tbody>
        {expired.map((t) => (
          <tr key={t.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
            <td
              className="py-2 px-3 mono"
              style={{ color: 'var(--text-2)', fontSize: 11 }}
            >
              {t.expiredAt}
            </td>
            <td className="py-2 px-3" style={{ fontWeight: 600 }}>
              {t.pair}
            </td>
            <td className="py-2 px-3">
              <span
                className={`badge ${t.side === 'RFQ_Buy' ? 'green' : 'red'} tiny`}
              >
                {t.side === 'RFQ_Buy' ? 'BUY' : 'SELL'}
              </span>
            </td>
            <td className="text-right py-2 px-3 mono">
              {fmt(t.size, 4)} {t.pair.split('/')[0]}
            </td>
            <td
              className="text-right py-2 px-3 mono"
              style={{ color: 'var(--text-2)' }}
            >
              {t.bestPrice ? fmt(t.bestPrice, 2) : '—'}
            </td>
            <td className="text-right py-2 px-3 mono">{t.quoteCount}</td>
            <td className="py-2 px-3">
              <span
                className="badge tiny"
                style={{
                  background: 'var(--border-soft)',
                  color: 'var(--text-2)',
                }}
              >
                {t.reason}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// === Compose RFQ sheet =====================================================

interface ComposeProps {
  trader: string;
  operator: string;
  onClose: () => void;
  onSubmit: (rfq: Rfq) => Promise<void> | void;
}

function ComposeRfqSheet({ trader, operator, onClose, onSubmit }: ComposeProps) {
  const [pair, setPair] = useState('BTC/USDC');
  const [side, setSide] = useState<RfqSide>('RFQ_Buy');
  const [size, setSize] = useState('');
  const [expiry, setExpiry] = useState(60);
  const [whitelist, setWhitelist] = useState<string[]>(
    whitelistedDealers().map((d) => d.party),
  );

  // Live mid prices from the operator backend. Source order:
  //   1. /v1/prices (pool-derived first, then PRICES env, then external feed)
  //   2. zero if no source has the pair
  // No hardcoded fallbacks — if the backend can't price it, the notional
  // shows "—" rather than misleading the user.
  const { data: pricesByPair } = useQuery({
    queryKey: ['prices', 'BTC/USDC,ETH/USDC,BTC/ETH,CC/USDC'],
    queryFn: async () => {
      const api = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';
      const res = await fetch(
        `${api}/v1/prices?pairs=BTC/USDC,ETH/USDC,BTC/ETH,CC/USDC`,
      );
      if (!res.ok) return {} as Record<string, number>;
      const body = (await res.json()) as {
        prices: Array<{ pair: string; price: string }>;
      };
      return Object.fromEntries(
        body.prices.map((p) => [p.pair, parseFloat(p.price)]),
      ) as Record<string, number>;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const toggleDealer = (p: string) =>
    setWhitelist((cur) =>
      cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p],
    );

  const sz = parseFloat(size) || 0;
  const refMid = pricesByPair?.[pair] ?? null;
  const notional = refMid != null ? sz * refMid : null;

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submit = async () => {
    if (!sz || !whitelist.length) return;
    setSubmitting(true);
    setSubmitError(null);
    // Local id is a placeholder; the backend assigns the real contract id
    // in onCompose and the optimistic row is rewritten with that cid.
    const placeholderId = 'rfq-' + Math.random().toString(16).slice(2, 6);
    try {
      await onSubmit({
        contractId: placeholderId,
        trader,
        operator,
        rfqId: placeholderId,
        pair,
        side,
        size: sz,
        expiresIn: expiry * 60,
        whitelist: [...whitelist],
        createdAt: new Date().toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        status: 'RFQ_Open',
        quotes: [],
      });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="New RFQ" onClose={onClose} width={760}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24 }}>
        <div>
          <div className="grid-2" style={{ marginBottom: 14 }}>
            <div className="field">
              <label>Pair</label>
              <select
                className="input"
                value={pair}
                onChange={(e) => setPair(e.target.value)}
              >
                <option>BTC/USDC</option>
                <option>ETH/USDC</option>
                <option>BTC/ETH</option>
                <option>CC/USDC</option>
              </select>
            </div>
            <div className="field">
              <label>Side</label>
              <div className="tabs">
                <button
                  className={side === 'RFQ_Buy' ? 'active' : ''}
                  onClick={() => setSide('RFQ_Buy')}
                >
                  Buy
                </button>
                <button
                  className={side === 'RFQ_Sell' ? 'active' : ''}
                  onClick={() => setSide('RFQ_Sell')}
                >
                  Sell
                </button>
              </div>
            </div>
          </div>

          <div className="field">
            <label>
              Size{' '}
              <span style={{ color: 'var(--text-2)', fontSize: 11 }}>
                {pair.split('/')[0]}
              </span>
            </label>
            <input
              className="input"
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              style={{
                fontSize: 18,
                fontFamily: 'var(--font-mono)',
              }}
            />
            {sz > 0 && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-2)',
                  marginTop: 6,
                }}
              >
                Notional ≈{' '}
                <span className="mono" style={{ color: 'var(--text)' }}>
                  {notional != null ? fmtUsd(notional) : '—'}
                </span>{' '}
                {refMid != null
                  ? 'at live mid'
                  : 'no price available — pool or feed required'}
              </div>
            )}
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <label>Quote validity window</label>
            <div className="tabs">
              {[15, 60, 240, 1440].map((m) => (
                <button
                  key={m}
                  className={expiry === m ? 'active' : ''}
                  onClick={() => setExpiry(m)}
                >
                  {m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : `${m / 1440}d`}
                </button>
              ))}
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-2)',
                marginTop: 6,
              }}
            >
              Dealers can post quotes up until this expiry. Individual quote
              validity is set per response.
            </div>
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-2)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 8,
            }}
          >
            Send to dealers · {whitelist.length} selected
          </div>
          <div
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 6,
              maxHeight: 280,
              overflow: 'auto',
            }}
          >
            {DEALERS.map((d) => {
              const checked = whitelist.includes(d.party);
              return (
                <label
                  key={d.party}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px',
                    cursor: 'pointer',
                    fontSize: 12,
                    borderRadius: 6,
                    background: checked
                      ? 'rgba(56,139,253,0.06)'
                      : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleDealer(d.party)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <span style={{ fontWeight: 600 }}>{d.name}</span>
                      {d.trusted && (
                        <span className="badge tiny green">trusted</span>
                      )}
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 10, color: 'var(--text-2)' }}
                    >
                      {d.party}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="mono" style={{ fontSize: 11 }}>
                      {d.ms}ms
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-2)' }}>
                      {Math.round(d.fillRate * 100)}% fill
                    </div>
                  </div>
                </label>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 10,
              padding: 10,
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 11,
              color: 'var(--text-2)',
              lineHeight: 1.55,
            }}
          >
            Off-ledger: request goes to selected dealers via private channel.
            On-ledger: an accepted quote becomes a MatchedTrade between you
            and that one dealer — no other party sees it.
          </div>
        </div>
      </div>

      <div
        className="row"
        style={{
          justifyContent: 'space-between',
          marginTop: 20,
          paddingTop: 16,
          borderTop: '1px solid var(--border)',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
          {sz > 0 && whitelist.length > 0 ? (
            <>
              Sending{' '}
              <span className="mono" style={{ color: 'var(--text)' }}>
                {side === 'RFQ_Buy' ? 'BUY' : 'SELL'} {fmt(sz, 4)}{' '}
                {pair.split('/')[0]}
              </span>{' '}
              to{' '}
              <span style={{ color: 'var(--text)' }}>{whitelist.length}</span>{' '}
              dealer{whitelist.length === 1 ? '' : 's'}
            </>
          ) : (
            <>Enter size and select at least one dealer</>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!sz || !whitelist.length || submitting}
            onClick={submit}
          >
            {submitting ? 'Sending…' : 'Send RFQ'}
          </button>
        </div>
      </div>
      {submitError && (
        <div
          style={{
            marginTop: 12,
            padding: '8px 10px',
            border: '1px solid var(--red, #ef4444)',
            borderRadius: 6,
            color: 'var(--text-2)',
            fontSize: 12,
          }}
        >
          Failed to send RFQ: {submitError}
        </div>
      )}
    </Modal>
  );
}

// === Operator policy modal =================================================

function PolicyModal({ rfq, onClose }: { rfq: Rfq; onClose: () => void }) {
  const ranked = rankQuotes(rfq.side, rfq.quotes, 'policy');
  return (
    <Modal title={`Operator policy · ${rfq.contractId}`} onClose={onClose} width={620}>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 12 }}>
        Version{' '}
        <span className="mono" style={{ color: 'var(--text)' }}>
          v1.4
        </span>{' '}
        · published by operator. Both trader and dealer can audit this against
        the on-chain config.
      </div>
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 12,
          fontSize: 12,
          marginBottom: 14,
        }}
      >
        <div className="section-h" style={{ marginBottom: 6 }}>
          Ranking chain
        </div>
        <div className="mono" style={{ lineHeight: 1.7 }}>
          1. Filter <span style={{ color: 'var(--text)' }}>validFor &gt; 0</span>
          <br />
          2. Sort by <span style={{ color: 'var(--text)' }}>tier</span> (trusted
          before whitelist)
          <br />
          3. Then by <span style={{ color: 'var(--text)' }}>price</span> (
          {rfq.side === 'RFQ_Buy' ? 'lowest' : 'highest'})
          <br />
          4. Then by <span style={{ color: 'var(--text)' }}>postedAt</span>{' '}
          (earliest)
          <br />
          5. Tiebreaker:{' '}
          <span style={{ color: 'var(--text)' }}>venue ID hash</span>
        </div>
      </div>
      <div className="section-h">Ranking applied right now</div>
      <table className="w-full text-xs">
        <thead>
          <tr style={{ color: 'var(--text-2)' }}>
            <th className="text-left py-1 px-2">#</th>
            <th className="text-left py-1 px-2">Dealer</th>
            <th className="text-right py-1 px-2">Price</th>
            <th className="text-right py-1 px-2">Tier</th>
            <th className="text-right py-1 px-2">Posted</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((q, i) => {
            const d = dealerByParty(q.dealer);
            return (
              <tr key={q.dealer}>
                <td className="py-1 px-2 mono">{i + 1}</td>
                <td className="py-1 px-2">
                  {d.name}{' '}
                  <span
                    className="mono"
                    style={{ color: 'var(--text-2)', fontSize: 10 }}
                  >
                    {q.dealer}
                  </span>
                </td>
                <td className="text-right py-1 px-2 mono">{fmt(q.price, 2)}</td>
                <td className="text-right py-1 px-2">
                  <span
                    className={`badge tiny ${q.tier === 'trusted' ? 'green' : ''}`}
                  >
                    {q.tier}
                  </span>
                </td>
                <td
                  className="text-right py-1 px-2 mono"
                  style={{ fontSize: 11 }}
                >
                  {q.postedAt}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Modal>
  );
}
