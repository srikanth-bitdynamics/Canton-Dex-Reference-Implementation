// Status badge. Direct port of cdex-primitives.jsx StatusBadge. The
// lookup map is the source of truth for "what badge to show for what
// state" across pages -- when adding a new status, add the mapping
// here rather than each call-site.

interface BadgeMeta {
  cls: string;
  label: string;
}

const STATUS_MAP: Record<string, BadgeMeta> = {
  Settled: { cls: 'green', label: 'Settled' },
  Complete: { cls: 'green', label: 'Complete' },
  Pending: { cls: 'amber', label: 'Pending' },
  Funded: { cls: 'blue', label: 'Funded' },
  PartiallyFilled: { cls: 'amber', label: 'Partial' },
  Cancelled: { cls: 'red', label: 'Cancelled' },
  Failed: { cls: 'red', label: 'Failed' },
  Active: { cls: 'green', label: 'Active' },
  Paused: { cls: 'amber', label: 'Paused' },
  Open: { cls: 'blue', label: 'Open' },
  Quoted: { cls: 'blue', label: 'Quoted' },
  Accepted: { cls: 'amber', label: 'Accepted' },
  Settling: { cls: 'blue', label: 'Settling' },
  Expired: { cls: '', label: 'Expired' },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_MAP[status] ?? { cls: '', label: status };
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>;
}
