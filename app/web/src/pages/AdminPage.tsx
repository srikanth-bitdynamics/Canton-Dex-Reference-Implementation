import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ledger } from '@/services/ledger';
import { OperatorApi } from '@/services/operator-api';

const operatorApi = new OperatorApi(
  (import.meta.env.VITE_OPERATOR_API as string | undefined) ?? '',
);

type TradingMode = 'TM_OrderBook' | 'TM_Pool' | 'TM_Both';

export function AdminPage() {
  const qc = useQueryClient();
  const { data: pairs } = useQuery({
    queryKey: ['pairs'],
    queryFn: ledger.getPairs,
  });
  const { data: pools } = useQuery({
    queryKey: ['pools'],
    queryFn: ledger.getPools,
  });

  const invalidatePairs = () =>
    qc.invalidateQueries({ queryKey: ['pairs'] });
  const invalidatePools = () =>
    qc.invalidateQueries({ queryKey: ['pools'] });

  const createPair = useMutation({
    mutationFn: operatorApi.createPair.bind(operatorApi),
    onSuccess: invalidatePairs,
  });
  const setPairActive = useMutation({
    mutationFn: ({ cid, active }: { cid: string; active: boolean }) =>
      operatorApi.setPairActive(cid, active),
    onSuccess: invalidatePairs,
  });
  const updateFeeModel = useMutation({
    mutationFn: ({
      cid,
      makerFeeBps,
      takerFeeBps,
      poolFeeBps,
    }: {
      cid: string;
      makerFeeBps: number;
      takerFeeBps: number;
      poolFeeBps: number;
    }) =>
      operatorApi.updatePairFeeModel(cid, {
        makerFeeBps,
        takerFeeBps,
        poolFeeBps,
      }),
    onSuccess: invalidatePairs,
  });
  const createPool = useMutation({
    mutationFn: operatorApi.createPool.bind(operatorApi),
    onSuccess: invalidatePools,
  });

  const [pairOpen, setPairOpen] = useState(false);
  const [poolOpen, setPoolOpen] = useState(false);
  // Per-pair fee-editing state. Null means "not editing"; an object means
  // the row is in inline-edit mode with the form values held here.
  const [editingFee, setEditingFee] = useState<{
    cid: string;
    maker: number;
    taker: number;
    pool: number;
  } | null>(null);

  return (
    <div className="space-y-6">
      <div className="bg-surface-card rounded-lg border border-surface-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-text-primary font-sans font-semibold">
            Trading Pairs
          </h3>
          <button
            className="px-3 py-1.5 rounded-lg text-sm font-sans bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors"
            onClick={() => setPairOpen(true)}
          >
            + Add Pair
          </button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-muted font-sans text-xs border-b border-surface-border">
              <th className="text-left pb-2">Pair</th>
              <th className="text-left pb-2">Mode</th>
              <th className="text-right pb-2">Maker Fee</th>
              <th className="text-right pb-2">Taker Fee</th>
              <th className="text-right pb-2">Pool Fee</th>
              <th className="text-center pb-2">Status</th>
              <th className="text-right pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {pairs?.map((pair) => (
              <tr
                key={pair.contractId}
                className="border-b border-surface-border/50 hover:bg-surface-hover"
              >
                <td className="py-2 font-mono text-text-primary">
                  {pair.baseInstrumentId}/{pair.quoteInstrumentId}
                </td>
                <td className="py-2 text-text-secondary font-sans">
                  {pair.tradingMode}
                </td>
                {editingFee?.cid === pair.contractId ? (
                  <>
                    <td className="py-2 text-right">
                      <input
                        type="number"
                        className="w-16 text-right bg-surface border border-surface-border rounded px-1 py-0.5 font-mono text-xs"
                        value={editingFee.maker}
                        onChange={(e) =>
                          setEditingFee({
                            ...editingFee,
                            maker: parseInt(e.target.value || '0', 10),
                          })
                        }
                      />
                    </td>
                    <td className="py-2 text-right">
                      <input
                        type="number"
                        className="w-16 text-right bg-surface border border-surface-border rounded px-1 py-0.5 font-mono text-xs"
                        value={editingFee.taker}
                        onChange={(e) =>
                          setEditingFee({
                            ...editingFee,
                            taker: parseInt(e.target.value || '0', 10),
                          })
                        }
                      />
                    </td>
                    <td className="py-2 text-right">
                      <input
                        type="number"
                        className="w-16 text-right bg-surface border border-surface-border rounded px-1 py-0.5 font-mono text-xs"
                        value={editingFee.pool}
                        onChange={(e) =>
                          setEditingFee({
                            ...editingFee,
                            pool: parseInt(e.target.value || '0', 10),
                          })
                        }
                      />
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-2 text-right font-mono text-text-primary">
                      {pair.feeModel.makerFeeBps} bps
                    </td>
                    <td className="py-2 text-right font-mono text-text-primary">
                      {pair.feeModel.takerFeeBps} bps
                    </td>
                    <td className="py-2 text-right font-mono text-text-primary">
                      {pair.feeModel.poolFeeBps} bps
                    </td>
                  </>
                )}
                <td className="py-2 text-center">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      pair.active
                        ? 'bg-accent-green/20 text-accent-green'
                        : 'bg-accent-red/20 text-accent-red'
                    }`}
                  >
                    {pair.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="py-2 text-right">
                  {editingFee?.cid === pair.contractId ? (
                    <div className="flex justify-end gap-2 text-xs">
                      <button
                        className="text-accent-green hover:underline"
                        disabled={updateFeeModel.isPending}
                        onClick={() => {
                          updateFeeModel.mutate(
                            {
                              cid: pair.contractId,
                              makerFeeBps: editingFee.maker,
                              takerFeeBps: editingFee.taker,
                              poolFeeBps: editingFee.pool,
                            },
                            { onSuccess: () => setEditingFee(null) },
                          );
                        }}
                      >
                        Save
                      </button>
                      <button
                        className="text-text-secondary hover:underline"
                        onClick={() => setEditingFee(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex justify-end gap-2 text-xs">
                      <button
                        className="text-text-secondary hover:text-text-primary"
                        onClick={() =>
                          setEditingFee({
                            cid: pair.contractId,
                            maker: pair.feeModel.makerFeeBps,
                            taker: pair.feeModel.takerFeeBps,
                            pool: pair.feeModel.poolFeeBps,
                          })
                        }
                      >
                        Edit fees
                      </button>
                      <button
                        className="text-accent-blue hover:underline"
                        onClick={() =>
                          setPairActive.mutate({
                            cid: pair.contractId,
                            active: !pair.active,
                          })
                        }
                        disabled={setPairActive.isPending}
                      >
                        {pair.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!pairs?.length && (
              <tr>
                <td
                  colSpan={7}
                  className="py-4 text-center text-text-muted font-sans"
                >
                  No pairs configured
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="bg-surface-card rounded-lg border border-surface-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-text-primary font-sans font-semibold">
            Pool Operations
          </h3>
          <button
            className="px-3 py-1.5 rounded-lg text-sm font-sans bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors"
            onClick={() => setPoolOpen(true)}
          >
            + Create Pool
          </button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-muted font-sans text-xs border-b border-surface-border">
              <th className="text-left pb-2">Pool</th>
              <th className="text-center pb-2">Status</th>
              <th className="text-right pb-2">Base Reserve</th>
              <th className="text-right pb-2">Quote Reserve</th>
              <th className="text-right pb-2">LP Supply</th>
            </tr>
          </thead>
          <tbody>
            {pools?.map((pool) => (
              <tr
                key={pool.contractId}
                className="border-b border-surface-border/50 hover:bg-surface-hover"
              >
                <td className="py-2 font-mono text-text-primary">
                  {pool.baseInstrumentId}/{pool.quoteInstrumentId}
                </td>
                <td className="py-2 text-center">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      pool.status === 'Active'
                        ? 'bg-accent-green/20 text-accent-green'
                        : pool.status === 'Paused'
                          ? 'bg-accent-yellow/20 text-accent-yellow'
                          : 'bg-surface-border text-text-muted'
                    }`}
                  >
                    {pool.status}
                  </span>
                </td>
                <td className="py-2 text-right font-mono text-text-primary">
                  {pool.reserves.baseAmount.toLocaleString()}
                </td>
                <td className="py-2 text-right font-mono text-text-primary">
                  {pool.reserves.quoteAmount.toLocaleString()}
                </td>
                <td className="py-2 text-right font-mono text-text-primary">
                  {pool.totalLpSupply.toFixed(4)}
                </td>
              </tr>
            ))}
            {!pools?.length && (
              <tr>
                <td
                  colSpan={5}
                  className="py-4 text-center text-text-muted font-sans"
                >
                  No pools created
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pairOpen && (
        <CreatePairForm
          onClose={() => setPairOpen(false)}
          onSubmit={(input) => {
            createPair.mutate(input, { onSuccess: () => setPairOpen(false) });
          }}
          pending={createPair.isPending}
        />
      )}

      {poolOpen && (
        <CreatePoolForm
          onClose={() => setPoolOpen(false)}
          onSubmit={(input) => {
            createPool.mutate(input, { onSuccess: () => setPoolOpen(false) });
          }}
          pending={createPool.isPending}
        />
      )}
    </div>
  );
}

interface CreatePairProps {
  onClose: () => void;
  onSubmit: (input: {
    admin: string;
    baseInstrumentId: string;
    quoteInstrumentId: string;
    tradingMode: TradingMode;
    feeModel: { makerFeeBps: number; takerFeeBps: number; poolFeeBps: number };
  }) => void;
  pending: boolean;
}

function CreatePairForm({ onClose, onSubmit, pending }: CreatePairProps) {
  const [base, setBase] = useState('BTC');
  const [quote, setQuote] = useState('USDC');
  const [admin, setAdmin] = useState('');
  const [mode, setMode] = useState<TradingMode>('TM_Both');
  const [maker, setMaker] = useState(10);
  const [taker, setTaker] = useState(20);
  const [pool, setPool] = useState(30);

  return (
    <FormShell title="Add Trading Pair" onClose={onClose}>
      <Field label="Admin party">
        <input
          className="input"
          value={admin}
          onChange={(e) => setAdmin(e.target.value)}
          placeholder="admin::pkg-id"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Base instrument">
          <input
            className="input"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
        </Field>
        <Field label="Quote instrument">
          <input
            className="input"
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Trading mode">
        <select
          className="input"
          value={mode}
          onChange={(e) => setMode(e.target.value as TradingMode)}
        >
          <option value="TM_OrderBook">Order book only</option>
          <option value="TM_Pool">Pool only</option>
          <option value="TM_Both">Both</option>
        </select>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Maker bps">
          <input
            className="input"
            type="number"
            value={maker}
            onChange={(e) => setMaker(parseInt(e.target.value || '0', 10))}
          />
        </Field>
        <Field label="Taker bps">
          <input
            className="input"
            type="number"
            value={taker}
            onChange={(e) => setTaker(parseInt(e.target.value || '0', 10))}
          />
        </Field>
        <Field label="Pool bps">
          <input
            className="input"
            type="number"
            value={pool}
            onChange={(e) => setPool(parseInt(e.target.value || '0', 10))}
          />
        </Field>
      </div>
      <FormActions onClose={onClose}>
        <button
          className="btn primary"
          disabled={pending || !admin || !base || !quote}
          onClick={() =>
            onSubmit({
              admin,
              baseInstrumentId: base,
              quoteInstrumentId: quote,
              tradingMode: mode,
              feeModel: {
                makerFeeBps: maker,
                takerFeeBps: taker,
                poolFeeBps: pool,
              },
            })
          }
        >
          {pending ? 'Creating…' : 'Create pair'}
        </button>
      </FormActions>
    </FormShell>
  );
}

interface CreatePoolProps {
  onClose: () => void;
  onSubmit: (input: {
    lpRegistrar: string;
    admin: string;
    baseInstrumentId: string;
    quoteInstrumentId: string;
    lpInstrumentId: string;
    feeBps: number;
  }) => void;
  pending: boolean;
}

function CreatePoolForm({ onClose, onSubmit, pending }: CreatePoolProps) {
  const [base, setBase] = useState('BTC');
  const [quote, setQuote] = useState('USDC');
  const [lp, setLp] = useState('BTC-USDC-LP');
  const [admin, setAdmin] = useState('');
  const [lpRegistrar, setLpRegistrar] = useState('');
  const [feeBps, setFeeBps] = useState(30);

  return (
    <FormShell title="Create Pool" onClose={onClose}>
      <Field label="Admin party">
        <input
          className="input"
          value={admin}
          onChange={(e) => setAdmin(e.target.value)}
        />
      </Field>
      <Field label="LP registrar party">
        <input
          className="input"
          value={lpRegistrar}
          onChange={(e) => setLpRegistrar(e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Base instrument">
          <input
            className="input"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
        </Field>
        <Field label="Quote instrument">
          <input
            className="input"
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
          />
        </Field>
      </div>
      <Field label="LP instrument id">
        <input
          className="input"
          value={lp}
          onChange={(e) => setLp(e.target.value)}
        />
      </Field>
      <Field label="Pool fee (bps)">
        <input
          className="input"
          type="number"
          value={feeBps}
          onChange={(e) => setFeeBps(parseInt(e.target.value || '0', 10))}
        />
      </Field>
      <FormActions onClose={onClose}>
        <button
          className="btn primary"
          disabled={pending || !admin || !lpRegistrar}
          onClick={() =>
            onSubmit({
              admin,
              lpRegistrar,
              baseInstrumentId: base,
              quoteInstrumentId: quote,
              lpInstrumentId: lp,
              feeBps,
            })
          }
        >
          {pending ? 'Creating…' : 'Create pool'}
        </button>
      </FormActions>
    </FormShell>
  );
}

function FormShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 460, padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="section-h" style={{ marginBottom: 12 }}>
          {title}
        </h3>
        <div className="space-y-3">{children}</div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{ display: 'block', fontSize: 11, color: 'var(--text-2)' }}
    >
      <div style={{ marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}

function FormActions({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
      <button className="btn ghost" onClick={onClose}>
        Cancel
      </button>
      {children}
    </div>
  );
}
