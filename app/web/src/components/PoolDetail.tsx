// Pool detail screen — add liquidity, remove liquidity, LP position
// summary, and on-ledger details. Direct port of `cdex-pools.jsx
// PoolDetail` adapted to the typed Pool shape.
//
// Add/remove liquidity are gated through `ledger.addLiquidity` /
// `ledger.removeLiquidity` (which delegates to wallet handoff for the
// trader-authority allocation creation).

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ASSETS } from '@/primitives/assets';
import { PairGlyph } from '@/primitives/Glyph';
import { StatusBadge } from '@/primitives/StatusBadge';
import { Spark } from '@/primitives/Spark';
import { fmt, fmtUsd, fmtUsdK } from '@/primitives/format';
import { useToast } from '@/primitives/ToastProvider';
import { useAssetPricesUsd } from '@/hooks/usePrices';
import { usePriceHistory, useStats24h } from '@/hooks/useStats';
import { ledger } from '@/services/ledger';
import type { Holding, Pool } from '@/types/contracts';
import { useCurrentParty } from '@/wallet/hooks';

interface Props {
  pool: Pool;
  holdings: Holding[];
  /** User's LP holding for this pool, if any. */
  lpHeld: number;
  onBack: () => void;
}

export function PoolDetail({ pool, holdings, lpHeld, onBack }: Props) {
  const party = useCurrentParty();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: context } = useQuery({
    queryKey: ['context'],
    queryFn: ledger.getContext,
  });
  // Live mid-price USD for both legs of the pool, and 24h stats / price
  // history from the indexer. All nullable — when no data is available
  // the UI renders "—" rather than a hallucinated delta.
  const { prices: priceUsd } = useAssetPricesUsd([
    pool.baseInstrumentId,
    pool.quoteInstrumentId,
  ]);
  const pairKey = `${pool.baseInstrumentId}/${pool.quoteInstrumentId}`;
  const { data: stats24h } = useStats24h(pairKey);
  const { data: priceHistory } = usePriceHistory(pairKey, 24);
  const refreshOnComplete = () => {
    void queryClient.invalidateQueries({ queryKey: ['pools'] });
    void queryClient.invalidateQueries({ queryKey: ['holdings'] });
  };
  const balanceOf = (s: string) =>
    holdings.find((h) => h.instrumentId === s && !h.locked)?.amount ?? 0;
  // The minimal head-first prefix of unlocked holdings whose cumulative
  // amount covers `target`. The wallet locks exactly these in the DvP
  // allocation; passing ALL holdings would over-lock and — since the
  // settle consumes every locked holding — over-burn / over-deposit a
  // fragmented position on a partial action (DEX-54 review). Best-effort:
  // returns the covering prefix (or all unlocked if it can't cover, so the
  // on-ledger allocate fails loudly rather than silently under-funding).
  const coveringHoldingCids = (s: string, target: number): string[] => {
    const out: string[] = [];
    let acc = 0;
    for (const h of holdings.filter((h) => h.instrumentId === s && !h.locked)) {
      if (acc >= target) break;
      out.push(h.contractId);
      acc += h.amount;
    }
    return out;
  };
  const ratio = pool.reserves.quoteAmount / pool.reserves.baseAmount;

  const [baseAmt, setBaseAmt] = useState('');
  const [quoteAmt, setQuoteAmt] = useState('');
  const [removePct, setRemovePct] = useState(50);
  // Slippage tolerance for add/remove liquidity. The pool's ratio can move
  // between quote and execute; we accept up to this much shortfall in LP
  // tokens minted (add) or underlying received (remove).
  const [lpSlippagePct, setLpSlippagePct] = useState(0.5);

  const sharePct =
    pool.totalLpSupply > 0 ? (lpHeld / pool.totalLpSupply) * 100 : 0;
  const userBaseValue =
    pool.totalLpSupply > 0
      ? (lpHeld / pool.totalLpSupply) * pool.reserves.baseAmount
      : 0;
  const userQuoteValue =
    pool.totalLpSupply > 0
      ? (lpHeld / pool.totalLpSupply) * pool.reserves.quoteAmount
      : 0;

  const newLpTokens = useMemo(() => {
    const b = parseFloat(baseAmt) || 0;
    if (!b || pool.reserves.baseAmount === 0) return 0;
    return (b / pool.reserves.baseAmount) * pool.totalLpSupply;
  }, [baseAmt, pool]);

  const onBaseChange = (v: string) => {
    const cleaned = v.replace(/[^0-9.]/g, '');
    setBaseAmt(cleaned);
    const num = parseFloat(cleaned);
    if (num > 0) {
      const decimals = ASSETS[pool.quoteInstrumentId]?.decimals ?? 2;
      setQuoteAmt((num * ratio).toFixed(decimals));
    } else setQuoteAmt('');
  };
  const onQuoteChange = (v: string) => {
    const cleaned = v.replace(/[^0-9.]/g, '');
    setQuoteAmt(cleaned);
    const num = parseFloat(cleaned);
    if (num > 0) {
      const decimals = ASSETS[pool.baseInstrumentId]?.decimals ?? 4;
      setBaseAmt((num / ratio).toFixed(decimals));
    } else setBaseAmt('');
  };

  const removeBase =
    pool.totalLpSupply > 0
      ? ((lpHeld * removePct) / 100 / pool.totalLpSupply) *
        pool.reserves.baseAmount
      : 0;
  const removeQuote =
    pool.totalLpSupply > 0
      ? ((lpHeld * removePct) / 100 / pool.totalLpSupply) *
        pool.reserves.quoteAmount
      : 0;

  const canAdd =
    !!party &&
    !!context &&
    parseFloat(baseAmt) > 0 &&
    parseFloat(baseAmt) <= balanceOf(pool.baseInstrumentId) &&
    parseFloat(quoteAmt) <= balanceOf(pool.quoteInstrumentId);
  const canRemove = !!party && lpHeld > 0;

  // Slippage-adjusted minimums applied to the on-chain choice. The pool's
  // ratio can shift between quote and execute; the wallet rejects the swap
  // if the actual return is below these floors.
  const minLpTokensWithSlippage = newLpTokens * (1 - lpSlippagePct / 100);
  const minBaseOutWithSlippage = removeBase * (1 - lpSlippagePct / 100);
  const minQuoteOutWithSlippage = removeQuote * (1 - lpSlippagePct / 100);

  const onAdd = async () => {
    if (!context) throw new Error('dApp context not loaded yet');
    toast.push(
      `Add liquidity: ${fmt(parseFloat(baseAmt), 4)} ${pool.baseInstrumentId} + ${fmt(parseFloat(quoteAmt), 2)} ${pool.quoteInstrumentId}`,
      'addLp',
      refreshOnComplete,
    );
    await ledger.addLiquidity({
      context,
      poolId: pool.contractId,
      baseAmount: parseFloat(baseAmt),
      quoteAmount: parseFloat(quoteAmt),
      minLpTokens: minLpTokensWithSlippage,
      baseHoldingCids: coveringHoldingCids(pool.baseInstrumentId, parseFloat(baseAmt)),
      quoteHoldingCids: coveringHoldingCids(pool.quoteInstrumentId, parseFloat(quoteAmt)),
    });
    setBaseAmt('');
    setQuoteAmt('');
  };

  const onRemove = async () => {
    if (!party) throw new Error('connect a wallet to remove liquidity');
    if (!context) throw new Error('dApp context not loaded yet');
    // Lock only the minimal LP-holding prefix that covers the redeem amount —
    // a partial remove must not burn the trader's whole fragmented position.
    const lpHoldingCids = coveringHoldingCids(pool.lpInstrumentId.id, (lpHeld * removePct) / 100);
    if (lpHoldingCids.length === 0) throw new Error('no unlocked LP holding to burn');
    toast.push(
      `Remove ${removePct}% LP from ${pool.baseInstrumentId}/${pool.quoteInstrumentId}`,
      'removeLp',
      refreshOnComplete,
    );
    await ledger.removeLiquidity({
      context,
      poolId: pool.contractId,
      holder: party,
      lpTokens: (lpHeld * removePct) / 100,
      minBaseOut: minBaseOutWithSlippage,
      minQuoteOut: minQuoteOutWithSlippage,
      holderLpHoldingCids: lpHoldingCids,
    });
  };

  return (
    <div className="page">
      <div style={{ marginBottom: 12 }}>
        <button className="btn ghost tiny" onClick={onBack}>
          ← All pools
        </button>
      </div>

      <div className="page-header">
        <div className="row">
          <PairGlyph
            base={pool.baseInstrumentId}
            quote={pool.quoteInstrumentId}
            size={32}
          />
          <div>
            <h1 className="page-title">
              {pool.baseInstrumentId} / {pool.quoteInstrumentId}
            </h1>
            <p className="page-sub">
              Constant-product pool · Fee {(pool.feeBps / 100).toFixed(2)}% ·{' '}
              <StatusBadge status={pool.status} />
            </p>
          </div>
        </div>
      </div>

      <div className="grid-3" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="stat-l">TVL</div>
          <div className="stat-v">
            {fmtUsdK(
              pool.reserves.baseAmount *
                (priceUsd[pool.baseInstrumentId] ?? 0) +
                pool.reserves.quoteAmount *
                  (priceUsd[pool.quoteInstrumentId] ?? 0),
            )}
          </div>
          <div className="stat-d">
            {fmt(pool.reserves.baseAmount, 4)} {pool.baseInstrumentId} ·{' '}
            {fmt(pool.reserves.quoteAmount, 0)} {pool.quoteInstrumentId}
          </div>
        </div>
        <div className="stat">
          <div className="stat-l">Mid price</div>
          <div className="stat-v">
            {fmt(
              pool.reserves.quoteAmount / Math.max(pool.reserves.baseAmount, 1),
              2,
            )}
          </div>
          <div
            className={
              stats24h?.priceChange24h == null
                ? 'stat-d'
                : stats24h.priceChange24h >= 0
                  ? 'stat-d up'
                  : 'stat-d down'
            }
          >
            {stats24h?.priceChange24h == null
              ? 'no 24h swaps yet'
              : `${stats24h.priceChange24h >= 0 ? '+' : ''}${(
                  stats24h.priceChange24h * 100
                ).toFixed(2)}% 24h`}
          </div>
        </div>
        <div className="stat">
          <div className="stat-l">k constant</div>
          <div className="stat-v">
            {fmt(pool.reserves.baseAmount * pool.reserves.quoteAmount, 0)}
          </div>
          <div className="stat-d">x · y = k</div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '460px 1fr',
          gap: 20,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Add liquidity */}
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Add liquidity</h3>
              <span className="card-sub">Match the pool ratio</span>
            </div>
            <div className="card-body">
              <div className="field">
                <div className="field-label">
                  <span>{pool.baseInstrumentId}</span>
                  <span style={{ color: 'var(--text-2)' }}>
                    Balance:{' '}
                    <span className="num">
                      {fmt(
                        balanceOf(pool.baseInstrumentId),
                        ASSETS[pool.baseInstrumentId]?.decimals ?? 4,
                      )}
                    </span>
                  </span>
                </div>
                <div className="field-row">
                  <input
                    value={baseAmt}
                    onChange={(e) => onBaseChange(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div className="sp-8" />
              <div className="field">
                <div className="field-label">
                  <span>{pool.quoteInstrumentId}</span>
                  <span style={{ color: 'var(--text-2)' }}>
                    Balance:{' '}
                    <span className="num">
                      {fmt(
                        balanceOf(pool.quoteInstrumentId),
                        ASSETS[pool.quoteInstrumentId]?.decimals ?? 2,
                      )}
                    </span>
                  </span>
                </div>
                <div className="field-row">
                  <input
                    value={quoteAmt}
                    onChange={(e) => onQuoteChange(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>

              {newLpTokens > 0 && (
                <>
                  <div className="sp-16" />
                  <div
                    style={{
                      background: 'var(--bg)',
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      padding: 12,
                    }}
                  >
                    <div className="kv">
                      <span className="k">Pool ratio</span>
                      <span className="v">
                        1 {pool.baseInstrumentId} ={' '}
                        <span className="num">{fmt(ratio, 2)}</span>{' '}
                        {pool.quoteInstrumentId}
                      </span>
                    </div>
                    <div className="kv">
                      <span className="k">Your share after</span>
                      <span className="v">
                        {(
                          (newLpTokens / (pool.totalLpSupply + newLpTokens)) *
                          100
                        ).toFixed(3)}
                        %
                      </span>
                    </div>
                    <div className="kv">
                      <span className="k">LP tokens to mint</span>
                      <span className="v">
                        <span className="num">{fmt(newLpTokens, 4)}</span>{' '}
                        {pool.baseInstrumentId}/{pool.quoteInstrumentId} LP
                      </span>
                    </div>
                    <div className="kv">
                      <span className="k">Min LP tokens (slippage)</span>
                      <span className="v">
                        <span className="num">{fmt(minLpTokensWithSlippage, 4)}</span>{' '}
                        at {lpSlippagePct}%
                      </span>
                    </div>
                  </div>
                </>
              )}

              <div className="sp-12" />
              <div className="row" style={{ gap: 6, fontSize: 11 }}>
                <span style={{ color: 'var(--text-2)' }}>LP slippage:</span>
                {[0.1, 0.5, 1.0, 2.0].map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`btn tiny ${lpSlippagePct === p ? 'primary' : 'ghost'}`}
                    onClick={() => setLpSlippagePct(p)}
                  >
                    {p}%
                  </button>
                ))}
              </div>

              <div className="sp-16" />
              <button
                className="btn primary block"
                disabled={!canAdd}
                onClick={onAdd}
              >
                {!parseFloat(baseAmt)
                  ? 'Enter amounts'
                  : !canAdd
                    ? 'Insufficient balance'
                    : 'Add liquidity'}
              </button>
            </div>
          </div>

          {/* Existing position */}
          {lpHeld > 0 && (
            <div className="card">
              <div className="card-head">
                <h3 className="card-title">Your LP position</h3>
                <span className="alloc-pill">LPToken#{pool.lpInstrumentId.id}</span>
              </div>
              <div className="card-body">
                <div className="grid-2">
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--text-2)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}
                    >
                      LP tokens
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 20, fontWeight: 600 }}
                    >
                      <span className="num">{fmt(lpHeld, 4)}</span>
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--text-2)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}
                    >
                      Pool share
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 20, fontWeight: 600 }}
                    >
                      {sharePct.toFixed(2)}%
                    </div>
                  </div>
                </div>
                <div className="sp-12" />
                <div className="kv">
                  <span className="k">Underlying {pool.baseInstrumentId}</span>
                  <span className="v">
                    <span className="num">
                      {fmt(
                        userBaseValue,
                        ASSETS[pool.baseInstrumentId]?.decimals ?? 4,
                      )}
                    </span>
                  </span>
                </div>
                <div className="kv">
                  <span className="k">Underlying {pool.quoteInstrumentId}</span>
                  <span className="v">
                    <span className="num">
                      {fmt(
                        userQuoteValue,
                        ASSETS[pool.quoteInstrumentId]?.decimals ?? 2,
                      )}
                    </span>
                  </span>
                </div>
                <div className="kv">
                  <span className="k">Position value</span>
                  <span className="v">
                    {priceUsd[pool.baseInstrumentId] != null &&
                    priceUsd[pool.quoteInstrumentId] != null
                      ? fmtUsd(
                          userBaseValue *
                            (priceUsd[pool.baseInstrumentId] as number) +
                            userQuoteValue *
                              (priceUsd[pool.quoteInstrumentId] as number),
                        )
                      : '—'}
                  </span>
                </div>

                <div className="sp-16" />
                <div className="section-h">Remove liquidity</div>
                <div className="row" style={{ gap: 6 }}>
                  {[25, 50, 75, 100].map((p) => (
                    <button
                      key={p}
                      className={`btn tiny ${removePct === p ? 'primary' : ''}`}
                      onClick={() => setRemovePct(p)}
                    >
                      {p}%
                    </button>
                  ))}
                </div>
                <div className="sp-12" />
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={removePct}
                  onChange={(e) => setRemovePct(parseInt(e.target.value, 10))}
                  className="w-full"
                />
                <div className="sp-12" />
                <div
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 12,
                  }}
                >
                  <div className="kv">
                    <span className="k">Receive {pool.baseInstrumentId}</span>
                    <span className="v">
                      <span className="num">
                        {fmt(
                          removeBase,
                          ASSETS[pool.baseInstrumentId]?.decimals ?? 4,
                        )}
                      </span>
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Receive {pool.quoteInstrumentId}</span>
                    <span className="v">
                      <span className="num">
                        {fmt(
                          removeQuote,
                          ASSETS[pool.quoteInstrumentId]?.decimals ?? 2,
                        )}
                      </span>
                    </span>
                  </div>
                  <div className="kv" style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 6, marginTop: 6 }}>
                    <span className="k">Min received ({lpSlippagePct}%)</span>
                    <span className="v" style={{ fontSize: 11, color: 'var(--text-2)' }}>
                      <span className="num">{fmt(minBaseOutWithSlippage, ASSETS[pool.baseInstrumentId]?.decimals ?? 4)}</span> {pool.baseInstrumentId}{' '}/{' '}
                      <span className="num">{fmt(minQuoteOutWithSlippage, ASSETS[pool.quoteInstrumentId]?.decimals ?? 2)}</span> {pool.quoteInstrumentId}
                    </span>
                  </div>
                </div>
                <div className="sp-12" />
                <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5, padding: '6px 8px', background: 'var(--bg-2)', borderRadius: 6 }}>
                  Delivery-versus-payment in three steps: the operator creates a{' '}
                  <span className="mono">LiquidityAllocationRequest</span> → your
                  wallet authors the base/quote receipt + LP burn-sender
                  allocations → the operator and lpRegistrar settle, delivering
                  the underlying to you and burning your LP tokens atomically.
                </div>
                <div className="sp-12" />
                <button
                  className="btn danger block"
                  onClick={onRemove}
                  disabled={!canRemove}
                  title={
                    !party
                      ? 'Connect a wallet to remove liquidity'
                      : !canRemove
                        ? 'No LP position to redeem'
                        : undefined
                  }
                >
                  Remove {removePct}% liquidity
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Pool depth</h3>
              <span className="card-sub">x · y = k</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <div
                style={{
                  height: 180,
                  margin: 14,
                  background:
                    'linear-gradient(180deg, rgba(63,185,80,0.08), transparent)',
                  border: '1px dashed var(--border)',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-3)',
                  fontSize: 12,
                }}
              >
                {priceHistory && priceHistory.length >= 2 ? (
                  <Spark
                    data={priceHistory.map((p) => p.price)}
                    width={400}
                    height={120}
                    color={
                      (stats24h?.priceChange24h ?? 0) >= 0
                        ? '#3FB950'
                        : '#F85149'
                    }
                  />
                ) : (
                  <div
                    style={{
                      color: 'var(--text-3)',
                      fontSize: 12,
                      textAlign: 'center',
                      padding: 24,
                    }}
                  >
                    — no swap history yet for this pair
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Pool details</h3>
            </div>
            <div className="card-body">
              <div className="kv">
                <span className="k">Reserves ({pool.baseInstrumentId})</span>
                <span className="v">
                  <span className="num">{fmt(pool.reserves.baseAmount, 4)}</span>
                </span>
              </div>
              <div className="kv">
                <span className="k">Reserves ({pool.quoteInstrumentId})</span>
                <span className="v">
                  <span className="num">{fmt(pool.reserves.quoteAmount, 2)}</span>
                </span>
              </div>
              <div className="kv">
                <span className="k">Total LP supply</span>
                <span className="v">
                  <span className="num">{fmt(pool.totalLpSupply, 4)}</span>
                </span>
              </div>
              <div className="kv">
                <span className="k">Pool contract</span>
                <span className="v alloc-pill">
                  Pool#{pool.contractId.slice(0, 6)}
                </span>
              </div>
              <div className="kv">
                <span className="k">LP token policy</span>
                <span className="v alloc-pill">
                  LPToken#{pool.lpInstrumentId.id}
                </span>
              </div>
              <div className="kv">
                <span className="k">{pool.baseInstrumentId} slices</span>
                <span className="v">
                  <span className="alloc-pill">
                    {pool.baseSlices.length} committed
                  </span>{' '}
                  <span className="badge green tiny" style={{ marginLeft: 4 }}>
                    slice-local
                  </span>
                </span>
              </div>
              <div className="kv">
                <span className="k">{pool.quoteInstrumentId} slices</span>
                <span className="v">
                  <span className="alloc-pill">
                    {pool.quoteSlices.length} committed
                  </span>{' '}
                  <span className="badge green tiny" style={{ marginLeft: 4 }}>
                    slice-local
                  </span>
                </span>
              </div>
              <div className="kv">
                <span className="k">Operator</span>
                <span className="v mono">{pool.operator}</span>
              </div>
              <div className="kv">
                <span className="k">LP registrar</span>
                <span className="v mono">{pool.lpRegistrar}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
