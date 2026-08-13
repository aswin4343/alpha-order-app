// Top Selling Products — reuses the same lightweight SVG donut approach as
// the Order Status chart (no external chart library). Shows the top N
// products by quantity this month, plus an "Other" slice for everything else
// so the chart stays readable regardless of catalogue size.

const SLICE_COLORS = ['#059669', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#94a3b8']

export default function TopProductsChart({ top, otherQty, totalQty }) {
  if (!top || top.length === 0) {
    return <p className="text-sm text-slate-400 text-center py-10">No products sold yet this month.</p>
  }

  const slices = [
    ...top.map((p, i) => ({ label: p.name, value: p.qty, color: SLICE_COLORS[i % SLICE_COLORS.length] })),
    ...(otherQty > 0 ? [{ label: 'Other Products', value: otherQty, color: SLICE_COLORS[SLICE_COLORS.length - 1] }] : [])
  ]

  const size = 132
  const stroke = 16
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2
  const circumference = 2 * Math.PI * r

  let offset = 0
  const arcs = slices.map((s) => {
    const frac = totalQty > 0 ? s.value / totalQty : 0
    const dash = frac * circumference
    const arc = (
      <circle
        key={s.label}
        cx={cx} cy={cy} r={r}
        fill="none" stroke={s.color} strokeWidth={stroke}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeDashoffset={-offset}
        transform={`rotate(-90 ${cx} ${cy})`}
        strokeLinecap={slices.length === 1 ? 'butt' : 'round'}
      />
    )
    offset += dash
    return arc
  })

  return (
    <div className="flex items-center gap-5 flex-wrap sm:flex-nowrap">
      <div className="shrink-0 mx-auto sm:mx-0">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f1f5f9" strokeWidth={stroke} />
          {arcs}
          <text x={cx} y={cy - 3} textAnchor="middle" className="fill-slate-800" style={{ fontSize: 20, fontWeight: 700 }}>
            {totalQty}
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 9 }}>
            Units sold
          </text>
        </svg>
      </div>
      <div className="flex-1 min-w-[180px] space-y-1.5 w-full">
        {slices.map((s) => (
          <div key={s.label} className="flex items-center justify-between text-sm gap-2">
            <span className="flex items-center gap-2 text-slate-600 min-w-0">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: s.color }} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="font-semibold text-slate-800 shrink-0">
              {totalQty > 0 ? Math.round((s.value / totalQty) * 100) : 0}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
