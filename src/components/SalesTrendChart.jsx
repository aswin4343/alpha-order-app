// Lightweight SVG line chart — no chart library needed, keeps the bundle lean
// and matches the app's existing minimal-dependency approach. Renders orders
// and revenue as two lines sharing the same x-axis (days), each on its own
// implicit scale so both stay readable regardless of magnitude difference.

function fmtDayLabel(dateStr) {
  try {
    return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  } catch { return dateStr }
}

export default function SalesTrendChart({ data, height = 180 }) {
  const width = 640
  const padL = 34
  const padR = 8
  const padT = 12
  const padB = 24
  const innerW = width - padL - padR
  const innerH = height - padT - padB

  if (!data || data.length === 0) {
    return <p className="text-sm text-slate-400 text-center py-10">No sales data yet for this period.</p>
  }

  const maxRevenue = Math.max(1, ...data.map((d) => d.revenue))
  const maxOrders = Math.max(1, ...data.map((d) => d.orders))

  const x = (i) => padL + (innerW * i) / Math.max(1, data.length - 1)
  const yRevenue = (v) => padT + innerH - (innerH * v) / maxRevenue
  const yOrders = (v) => padT + innerH - (innerH * v) / maxOrders

  const revenuePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${yRevenue(d.revenue).toFixed(1)}`).join(' ')
  const ordersPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${yOrders(d.orders).toFixed(1)}`).join(' ')

  // Show ~5 evenly-spaced x-axis labels so it doesn't get crowded on mobile.
  const labelStep = Math.max(1, Math.ceil(data.length / 5))
  const labels = data.filter((_, i) => i % labelStep === 0 || i === data.length - 1)

  // Gridlines (4 horizontal bands).
  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => padT + innerH * f)

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
        {gridYs.map((gy, i) => (
          <line key={i} x1={padL} x2={width - padR} y1={gy} y2={gy} stroke="#f1f5f9" strokeWidth="1" />
        ))}
        {/* Revenue area fill (subtle) */}
        <path
          d={`${revenuePath} L ${x(data.length - 1).toFixed(1)} ${padT + innerH} L ${x(0).toFixed(1)} ${padT + innerH} Z`}
          fill="#05966912"
        />
        <path d={revenuePath} fill="none" stroke="#059669" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={ordersPath} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="4 3" />

        {/* x-axis labels */}
        {labels.map((d) => (
          <text
            key={d.date}
            x={x(data.indexOf(d))}
            y={height - 6}
            textAnchor="middle"
            className="fill-slate-400"
            style={{ fontSize: 9 }}
          >
            {fmtDayLabel(d.date)}
          </text>
        ))}
      </svg>
      <div className="flex items-center gap-4 justify-center mt-1">
        <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="h-0.5 w-4 rounded-full inline-block" style={{ background: '#059669' }} /> Revenue
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="h-0.5 w-4 rounded-full inline-block" style={{ background: '#3b82f6', borderTop: '2px dashed #3b82f6' }} /> Orders
        </span>
      </div>
    </div>
  )
}
