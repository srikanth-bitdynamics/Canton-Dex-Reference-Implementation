// Empty / loading state, per the design system: one sentence + one action,
// on the brand's dot-grid texture. Icons are functional-only in this system,
// so empty states carry no artwork — the texture is the visual.

import type { ReactNode } from 'react';

export function EmptyState({
  title,
  children,
  action,
  compact = false,
}: {
  /** Optional short heading (sentence case). */
  title?: string;
  /** One sentence. */
  children: ReactNode;
  /** Optional single action (a button or link). */
  action?: ReactNode;
  /** Tighter padding for in-card use. */
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? 'compact' : ''}`}>
      {title && <div className="empty-state-title">{title}</div>}
      <div className="empty-state-body">{children}</div>
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
