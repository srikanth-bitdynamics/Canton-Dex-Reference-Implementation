// Inline sparkline. Direct port of cdex-primitives.jsx Spark + genSpark.
// The deterministic-seeded generator is a development convenience for
// rendering "looks like a chart" placeholders without a price feed; the
// production replacement is a real timeseries from the operator
// backend's /v1/pools/{id}/price-history endpoint (not built yet).

interface SparkProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}

export function Spark({
  data,
  color = '#3FB950',
  width = 80,
  height = 22,
}: SparkProps) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data
    .map(
      (d, i) =>
        `${(i * stepX).toFixed(1)},${(
          height -
          ((d - min) / range) * height
        ).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function genSpark(seed = 1, len = 24, vol = 0.06): number[] {
  const out: number[] = [];
  let v = 100;
  let s = seed * 9301 + 49297;
  for (let i = 0; i < len; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280 - 0.5;
    v += v * vol * r;
    out.push(v);
  }
  return out;
}
