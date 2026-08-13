import { useState } from 'react'

// Top Selling Products — ranked by quantity sold AND by number of distinct
// orders containing the product, side by side, so it's clear whether a
// product is popular (bought by many shops) or just bulk-bought by one.
// Shows a compact top-5 view with the rest expandable, so nothing is hidden.

const SLICE_COLORS = ['#059669', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#94a3b8']

function MiniDonut({ top, otherValue, total, valueKey }) {
  const size = 116
  const stroke = 15
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2
  const circumference = 2 * Math.PI * r

  const slices = [
    ...top.map((p, i) => ({ label: p.name, value: p[valueKey], color: SLICE_COLORS[i % SLICE_COLORS.length] })),
    ...(otherValue > 0 ? [{ label: 'Other', value: otherValue, color: SLICE_COLORS[SLICE_COLORS.length - 1] }] : [])
  ]

  let offset = 0
  const arcs = slices.map((s) => {
    const frac = total > 0 ? s.value / total : 0
    const dash = frac * circumference
    const arc = (
      <circle
        key={s.label} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
        strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset}
        transform={`rotate(-90 ${cx} ${cy})`}
        strokeLinecap={slices.length === 1 ? 'butt' : 'round'}
      />
    )
    offset += dash
    return arc
  })

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f1f5f9" strokeWidth={stroke} />
      {arcs}
      <text x={cx} y={cy - 2} textAnchor="middle" className="fill-slate-800" style={{ fontSize: 17, fontWeight: 700 }}>
        {total}
      </text>
    </svg>
  )
}

function RankedList({ rows, valueKey, valueSuffix, total, expanded, onToggle }) {
  const shown = expanded ? rows : rows.slice(0, 5)
  const remaining = rows.length - 5

  return (
    <div>
      {shown.map((p, i) => (
        <div key={p.name} className="flex items-center justify-between text-sm py-1 gap-2">
          <span className="flex items-center gap-2 text-slate-600 min-w-0">
            <span
              className="h-2.5 w-2.5 rounded-full shrink-0"
              style={{ background: i < 5 ? SLICE_COLORS[i % SLICE_COLORS.length] : '#cbd5e1' }}
            />
            <span className="truncate">{p.name}</span>
          </span>
          <span className="font-semibold text-slate-800 shrink-0">
            {p[valueKey]}{valueSuffix} <span className="text-slate-400 font-normal">({total > 0 ? Math.round((p[valueKey] / total) * 100) : 0}%)</span>
          </span>
        </div>
      ))}
      {rows.length === 0 && <p className="text-sm text-slate-400 text-center py-4">No data.</p>}
      {remaining > 0 && (
        <button
          onClick={onToggle}
          className="w-full text-center text-xs font-semibold text-brand-600 mt-2 py-1.5 rounded-lg hover:bg-brand-50"
        >
          {expanded ? 'Show less' : `Show ${remaining} more product${remaining === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  )
}

export default function TopProductsChart({ byQty, byOrders, totalQty, totalOrders }) {
  const [metric, setMetric] = useState('qty') // 'qty' | 'orders'
  const [expanded, setExpanded] = useState(false)

  const rows = metric === 'qty' ? byQty : byOrders
  const valueKey = metric === 'qty' ? 'qty' : 'orderCount'
  const total = metric === 'qty' ? totalQty : totalOrders

  if (!rows || rows.length === 0) {
    return <p className="text-sm text-slate-400 text-center py-10">No products sold in this range.</p>
  }

  const top5 = rows.slice(0, 5)
  const otherValue = total - top5.reduce((s, p) => s + p[valueKey], 0)

  return (
    <div>
      {/* Metric toggle */}
      <div className="flex gap-1.5 mb-3">
        <button
          onClick={() => { setMetric('qty'); setExpanded(false) }}
          className={`flex-1 py-1.5 rounded-lg text-xs font-bold ${metric === 'qty' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
        >
          By Quantity
        </button>
        <button
          onClick={() => { setMetric('orders'); setExpanded(false) }}
          className={`flex-1 py-1.5 rounded-lg text-xs font-bold ${metric === 'orders' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
        >
          By Orders
        </button>
      </div>

      <div className="flex items-start gap-4 flex-wrap sm:flex-nowrap">
        <div className="shrink-0 mx-auto sm:mx-0">
          <MiniDonut top={top5} otherValue={otherValue} total={total} valueKey={valueKey} />
          <p className="text-[10px] text-slate-400 text-center mt-1">
            {metric === 'qty' ? 'Units sold' : 'Orders'}
          </p>
        </div>
        <div className="flex-1 min-w-[200px] w-full">
          <RankedList
            rows={rows}
            valueKey={valueKey}
            valueSuffix={metric === 'qty' ? ' units' : ' orders'}
            total={total}
            expanded={expanded}
            onToggle={() => setExpanded((e) => !e)}
          />
        </div>
      </div>
    </div>
  )
}
