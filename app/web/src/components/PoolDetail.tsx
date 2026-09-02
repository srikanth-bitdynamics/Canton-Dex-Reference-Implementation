// Pool detail screen: add liquidity, remove liquidity, LP position
// summary, and on-ledger details.
//
// Add/remove liquidity are gated through `ledger.addLiquidity` /
// `ledger.removeLiquidity` (which delegates to wallet handoff for the
// trader-authority allocation creation).

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ASSETS, instrumentLabel } from '@/primitives/assets';
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
  const baseId = pool.baseInstrumentId.id;
  const quoteId = pool.quoteInstrumentId.id;
  const baseLabel = instrumentLabel(baseId);
  const quoteLabel = instrumentLabel(quoteId);
  const { data: context } = useQuery({
    queryKey: ['context'],
    queryFn: ledger.getContext,
  });
  // Live mid-price USD for both legs of the pool, and 24h stats / price
  // history from the indexer. All nullable — when no data is available
  // the UI renders "—" rather than a hallucinated delta.
  const { prices: priceUsd } = useAssetPricesUsd([
    baseId,
    quoteId,
  ]);
  const pairKey = `${baseId}/${quoteId}`;
  const { data: stats24h } = useStats24h(pairKey);
  const { data: priceHistory } = usePriceHistory(pairKey, 24);
  const refreshOnComplete = () => {
    void queryClient.invalidateQueries({ queryKey: ['pools'] });
    void queryClient.invalidateQueries({ queryKey: ['holdings'] });
  };
  const balanceOf = (s: string) =>
    holdings.find((h) => h.instrumentId === s && !h.locked)?.amount ?? 0;
  // The minimal head-first prefix of unlocked holdings whose cumulative
  // amount covers `target`. The wallet locks these in the DvP allocation.
  // Over-locking is harmless for correctness — the deposit/burn leg amount is
  // the action input (authored separately), and Allocation_Settle returns any
  // surplus of the locked backing to the owner as unlocked change — but the
  // minimal prefix keeps the surplus (and the number of holdings churned)
  // small. Best-effort: returns the covering prefix (or all unlocked if it
  // can't cover, so the on-ledger allocate fails loudly rather than silently
  // under-funding).
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
  // An Unfunded pool has no reserves and therefore no ratio to match: the first
  // deposit sets the opening price, so both amounts stay independent inputs.
  const isFirstDeposit =
    pool.reserves.baseAmount <= 0 ||
    pool.reserves.quoteAmount <= 0 ||
    pool.totalLpSupply <= 0;
  const ratio = isFirstDeposit
    ? null
    : pool.reserves.quoteAmount / pool.reserves.baseAmount;

  const [baseAmt, setBaseAmt] = useState('');
  const [quoteAmt, setQuoteAmt] = useState('');
  const [removePct, setRemovePct] = useState(50);
  const [liquidityError, setLiquidityError] = useState<string | null>(null);
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
    const q = parseFloat(quoteAmt) || 0;
    // First deposit mints sqrt(base*quote) LP (the on-ledger initial-LP formula);
    // later deposits mint pro-rata against existing reserves.
    if (isFirstDeposit) return b > 0 && q > 0 ? Math.sqrt(b * q) : 0;
    if (!b || pool.reserves.baseAmount === 0) return 0;
    return (b / pool.reserves.baseAmount) * pool.totalLpSupply;
  }, [baseAmt, quoteAmt, pool, isFirstDeposit]);

  const onBaseChange = (v: string) => {
    const cleaned = v.replace(/[^0-9.]/g, '');
    setBaseAmt(cleaned);
    // First deposit: leave the other side free so the LP sets the ratio.
    if (ratio === null) return;
    const num = parseFloat(cleaned);
    if (num > 0) {
      const decimals = ASSETS[quoteId]?.decimals ?? 2;
      setQuoteAmt((num * ratio).toFixed(decimals));
    } else setQuoteAmt('');
  };
  const onQuoteChange = (v: string) => {
    const cleaned = v.replace(/[^0-9.]/g, '');
    setQuoteAmt(cleaned);
    if (ratio === null) return;
    const num = parseFloat(cleaned);
    if (num > 0) {
      const decimals = ASSETS[baseId]?.decimals ?? 4;
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
    parseFloat(quoteAmt) > 0 &&
    parseFloat(baseAmt) <= balanceOf(baseId) &&
    parseFloat(quoteAmt) <= balanceOf(quoteId);
  const canRemove = !!party && lpHeld > 0;

  // The price the panel shows: the live pool ratio, or the one the LP is setting
  // on a first deposit.
  const shownRatio =
    ratio !== null
      ? ratio
      : parseFloat(baseAmt) > 0
        ? parseFloat(quoteAmt) / parseFloat(baseAmt)
        : 0;

  // Slippage-adjusted minimums applied to the on-chain choice. The pool's
  // ratio can shift between quote and execute; the wallet rejects the swap
  // if the actual return is below these floors.
  const minLpTokensWithSlippage = newLpTokens * (1 - lpSlippagePct / 100);
  const minBaseOutWithSlippage = removeBase * (1 - lpSlippagePct / 100);
  const minQuoteOutWithSlippage = removeQuote * (1 - lpSlippagePct / 100);

  const onAdd = async () => {
    if (!context) throw new Error('dApp context not loaded yet');
    setLiquidityError(null);
    const toastId = toast.push(
      `Add liquidity: ${fmt(parseFloat(baseAmt), 4)} ${baseLabel} + ${fmt(parseFloat(quoteAmt), 2)} ${quoteLabel}`,
      'addLp',
      refreshOnComplete,
    );
    try {
      await ledger.addLiquidity({
        poolId: pool.contractId,
        baseAmount: parseFloat(baseAmt),
        quoteAmount: parseFloat(quoteAmt),
        minLpTokens: minLpTokensWithSlippage,
        baseHoldingCids: coveringHoldingCids(baseId, parseFloat(baseAmt)),
        quoteHoldingCids: coveringHoldingCids(quoteId, parseFloat(quoteAmt)),
      });
      // Settle returned — only now mark the lifecycle complete (the card sat on
      // its first step through the wallet approval rather than racing to done).
      toast.complete(toastId);
      setBaseAmt('');
      setQuoteAmt('');
    } catch (error) {
      toast.dismiss(toastId);
      setLiquidityError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const onRemove = async () => {
    if (!party) throw new Error('connect a wallet to remove liquidity');
    if (!context) throw new Error('dApp context not loaded yet');
    setLiquidityError(null);
    const toastId = toast.push(
      `Remove ${removePct}% LP from ${baseLabel}/${quoteLabel}`,
      'removeLp',
      refreshOnComplete,
    );
    try {
      await ledger.removeLiquidity({
        poolId: pool.contractId,
        holder: party,
        lpAdmin: pool.lpInstrumentId.admin,
        lpInstrumentId: pool.lpInstrumentId.id,
        lpTokens: (lpHeld * removePct) / 100,
        minBaseOut: minBaseOutWithSlippage,
        minQuoteOut: minQuoteOutWithSlippage,
      });
      // Settle returned — only now mark the lifecycle complete.
      toast.complete(toastId);
    } catch (error) {
      toast.dismiss(toastId);
      setLiquidityError(error instanceof Error ? error.message : String(error));
      throw error;
    }
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
            base={baseId}
            quote={quoteId}
            size={32}
          />
          <div>
            <h1 className="page-title">
              {baseLabel} / {quoteLabel}
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
                (priceUsd[baseId] ?? 0) +
                pool.reserves.quoteAmount *
                  (priceUsd[quoteId] ?? 0),
            )}
          </div>
          <div className="stat-d">
            {fmt(pool.reserves.baseAmount, 4)} {baseLabel} ·{' '}
            {fmt(pool.reserves.quoteAmount, 0)} {quoteLabel}
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
              <span className="card-sub">
                {isFirstDeposit
                  ? 'First deposit — you set the price'
                  : 'Match the pool ratio'}
              </span>
            </div>
            <div className="card-body">
              <div className="field">
                <div className="field-label">
                  <span>{baseLabel}</span>
                  <span style={{ color: 'var(--text-2)' }}>
                    Balance:{' '}
                    <span className="num">
                      {fmt(
                        balanceOf(baseId),
                        ASSETS[baseId]?.decimals ?? 4,
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
                  <span>{quoteLabel}</span>
                  <span style={{ color: 'var(--text-2)' }}>
                    Balance:{' '}
                    <span className="num">
                      {fmt(
                        balanceOf(quoteId),
                        ASSETS[quoteId]?.decimals ?? 2,
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
                      <span className="k">
                        {isFirstDeposit ? 'Opening price' : 'Pool ratio'}
                      </span>
                      <span className="v">
                        1 {baseLabel} ={' '}
                        <span className="num">{fmt(shownRatio, 2)}</span>{' '}
                        {quoteLabel}
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
                        {baseLabel}/{quoteLabel} LP
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
              {liquidityError && (
                <>
                  <div
                    className="rounded px-3 py-2 text-sm"
                    style={{
                      background: 'rgba(248, 81, 73, 0.08)',
                      border: '1px solid var(--red)',
                      color: 'var(--red)',
                    }}
                  >
                    {liquidityError}
                  </div>
                  <div className="sp-12" />
                </>
              )}
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
                  <span className="k">Underlying {baseLabel}</span>
                  <span className="v">
                    <span className="num">
                      {fmt(
                        userBaseValue,
                        ASSETS[baseId]?.decimals ?? 4,
                      )}
                    </span>
                  </span>
                </div>
                <div className="kv">
                  <span className="k">Underlying {quoteLabel}</span>
                  <span className="v">
                    <span className="num">
                      {fmt(
                        userQuoteValue,
                        ASSETS[quoteId]?.decimals ?? 2,
                      )}
                    </span>
                  </span>
                </div>
                <div className="kv">
                  <span className="k">Position value</span>
                  <span className="v">
                    {priceUsd[baseId] != null &&
                    priceUsd[quoteId] != null
                      ? fmtUsd(
                          userBaseValue *
                            (priceUsd[baseId] as number) +
                            userQuoteValue *
                              (priceUsd[quoteId] as number),
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
                    <span className="k">Receive {baseLabel}</span>
                    <span className="v">
                      <span className="num">
                        {fmt(
                          removeBase,
                          ASSETS[baseId]?.decimals ?? 4,
                        )}
                      </span>
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Receive {quoteLabel}</span>
                    <span className="v">
                      <span className="num">
                        {fmt(
                          removeQuote,
                          ASSETS[quoteId]?.decimals ?? 2,
                        )}
                      </span>
                    </span>
                  </div>
                  <div className="kv" style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 6, marginTop: 6 }}>
                    <span className="k">Min received ({lpSlippagePct}%)</span>
                    <span className="v" style={{ fontSize: 11, color: 'var(--text-2)' }}>
                      <span className="num">{fmt(minBaseOutWithSlippage, ASSETS[baseId]?.decimals ?? 4)}</span> {baseLabel}{' '}/{' '}
                      <span className="num">{fmt(minQuoteOutWithSlippage, ASSETS[quoteId]?.decimals ?? 2)}</span> {quoteLabel}
                    </span>
                  </div>
                </div>
                <div className="sp-12" />
                <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5, padding: '6px 8px', background: 'var(--bg-2)', borderRadius: 6 }}>
                  Live-ledger DvP design in three steps: the operator creates a{' '}
                  <span className="mono">LiquidityAllocationRequest</span> → your
                  wallet authors the base/quote receipt + LP burn-sender
                  allocations → the operator and lpRegistrar settle, delivering
                  the underlying to you and burning your LP tokens atomically.
                </div>
                <div className="sp-12" />
                {liquidityError && (
                  <>
                    <div
                      className="rounded px-3 py-2 text-sm"
                      style={{
                        background: 'rgba(248, 81, 73, 0.08)',
                        border: '1px solid var(--red)',
                        color: 'var(--red)',
                      }}
                    >
                      {liquidityError}
                    </div>
                    <div className="sp-12" />
                  </>
                )}
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
                <span className="k">Reserves ({baseLabel})</span>
                <span className="v">
                  <span className="num">{fmt(pool.reserves.baseAmount, 4)}</span>
                </span>
              </div>
              <div className="kv">
                <span className="k">Reserves ({quoteLabel})</span>
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
                <span className="k">{baseLabel} slices</span>
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
                <span className="k">{quoteLabel} slices</span>
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
