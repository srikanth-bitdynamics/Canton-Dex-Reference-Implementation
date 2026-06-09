// Asset glyph + paired-asset glyph + asset chip. CSS lives in index.css
// under .glyph and .asset; the components only set sizes and child
// elements.

import { ASSETS, GLYPH_LABEL } from './assets';

interface GlyphProps {
  sym: string;
  size?: number;
}

export function Glyph({ sym, size = 22 }: GlyphProps) {
  const g = ASSETS[sym]?.glyph ?? 'cc';
  const label = GLYPH_LABEL[sym] ?? sym.slice(0, 1);
  return (
    <span
      className={`glyph ${g}`}
      style={{ width: size, height: size, fontSize: size * 0.5 }}
    >
      {label}
    </span>
  );
}

export function PairGlyph({
  base,
  quote,
  size = 22,
}: {
  base: string;
  quote: string;
  size?: number;
}) {
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        width: size + 12,
        height: size,
      }}
    >
      <span style={{ position: 'absolute', left: 0, top: 0 }}>
        <Glyph sym={base} size={size} />
      </span>
      <span style={{ position: 'absolute', left: 12, top: 0 }}>
        <Glyph sym={quote} size={size} />
      </span>
    </span>
  );
}

export function AssetChip({
  sym,
  onClick,
  caret = true,
}: {
  sym: string;
  onClick?: () => void;
  caret?: boolean;
}) {
  return (
    <button className="asset" onClick={onClick} type="button">
      <Glyph sym={sym} />
      <span>{sym}</span>
      {caret && (
        <span style={{ color: 'var(--text-2)', fontSize: 10, marginLeft: 2 }}>
          ▾
        </span>
      )}
    </button>
  );
}
