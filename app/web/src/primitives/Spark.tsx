// Inline sparkline for live price history panels.

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
