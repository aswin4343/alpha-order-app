import { useState, useEffect } from 'react'
import { loadApprovalHistory } from '../utils/cloudSync.js'

const fmt = (n) => n != null ? `₹${Number(n).toLocaleString('en-IN')}` : '—'
const fmtPct = (norm, req) => {
  if (norm == null || req == null || norm === 0) return '—'
  const p = ((req - norm) / norm * 100).toFixed(1)
  return `${parseFloat(p) > 0 ? '+' : ''}${p}%`
}
const REASON_LABELS = { competitor: 'Competitor Price', bulk: 'Bulk Quantity', near_expiry: 'Near Expiry', others: 'Others' }

function exportToCSV(rows) {
  const cols = ['Date','Order Date','Sales Rep','Shop','Route','Product','Price Type','Normal Price','Requested Price','Diff','Diff %','Decision','Reason','Competitor','Other Reason','Decided By','Decided At']
  const lines = [cols.join(',')]
  for (const r of rows) {
    const diff = r.normal_price != null && r.requested_price != null ? (r.requested_price - r.normal_price).toFixed(2) : ''
    const pct = r.normal_price ? ((r.requested_price - r.normal_price) / r.normal_price * 100).toFixed(1) + '%' : ''
    lines.push([
      r.created_at?.slice(0,10), r.order_date||'', r.sales_rep_name||'', r.shop_name||'', r.route||'',
      r.product_name||'', r.price_type||'',
      r.normal_price??'', r.requested_price??'', diff, pct,
      r.decision||'',
      REASON_LABELS[r.reason_type]||r.reason_type||'',
      r.competitor_name||'', r.other_reason||r.rejection_reason||'',
      r.decided_by||'', r.decided_at?.slice(0,19)?.replace('T',' ')||''
    ].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','))
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
  a.download = `Price_Approval_History_${new Date().toISOString().slice(0,10)}.csv`
  a.click(); URL.revokeObjectURL(a.href)
}

export default function AdminPriceApprovalReportPage() {
  const [rows, setRows] = useState(null)
  const [from, setFrom] = useState('')
  const [to, setTo]     = useState('')
  const [rep, setRep]   = useState('')
  const [filter, setFilter] = useState('all') // all | approved | rejected

  const load = () => {
    setRows(null)
    loadApprovalHistory({ fromDate: from||undefined, toDate: to||undefined, repName: rep.trim()||undefined })
      .then(setRows).catch(()=>setRows([]))
  }
  useEffect(() => { load() }, [])

  const displayed = (rows||[]).filter(r => filter==='all' || r.decision===filter)

  return (
    <div className="px-3 sm:px-6 pt-4 pb-10">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Price Approval History</h1>
          <p className="text-[12px] text-slate-400">Permanent audit log of every price approval/rejection.</p>
        </div>
        <button onClick={()=>exportToCSV(displayed)} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">
          ↓ Export CSV
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <input type="date" value={from} onChange={e=>setFrom(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm" placeholder="From"/>
        <input type="date" value={to} onChange={e=>setTo(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm" placeholder="To"/>
        <input value={rep} onChange={e=>setRep(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm" placeholder="Sales Rep name"/>
        <select value={filter} onChange={e=>setFilter(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm bg-white">
          <option value="all">All decisions</option>
          <option value="approved">Approved only</option>
          <option value="rejected">Rejected only</option>
        </select>
        <button onClick={load} className="rounded-lg bg-brand-600 text-white px-3 py-1.5 text-sm font-semibold">Search</button>
      </div>

      {rows==null ? (
        <div className="py-16 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin"/></div>
      ) : displayed.length===0 ? (
        <div className="py-12 text-center text-slate-400 text-sm">No records found.</div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-100 shadow-sm">
          <table className="min-w-full text-[11px] text-left">
            <thead className="bg-slate-50 text-slate-500 uppercase text-[9px] tracking-wide">
              <tr>{['Date','Rep','Shop','Product','Type','Normal','Requested','Diff','%','Decision','Reason','Details','By'].map(h=>(
                <th key={h} className="px-3 py-2 font-semibold whitespace-nowrap">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {displayed.map(r=>{
                const diff=r.normal_price!=null&&r.requested_price!=null?r.requested_price-r.normal_price:null
                const isApproved=r.decision==='approved'
                return(
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 whitespace-nowrap text-slate-400">{r.order_date||r.created_at?.slice(0,10)}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-medium text-slate-700">{r.sales_rep_name||'—'}</td>
                    <td className="px-3 py-2 text-slate-600">{r.shop_name||'—'}</td>
                    <td className="px-3 py-2 font-semibold text-slate-800">{r.product_name}</td>
                    <td className="px-3 py-2 text-slate-400">{r.price_type||'—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmt(r.normal_price)}</td>
                    <td className="px-3 py-2 font-bold whitespace-nowrap text-purple-700">{fmt(r.requested_price)}</td>
                    <td className={`px-3 py-2 font-semibold whitespace-nowrap ${diff!=null&&diff<0?'text-red-600':'text-emerald-700'}`}>
                      {diff!=null?`${diff>0?'+':''}₹${diff.toFixed(2)}`:'—'}
                    </td>
                    <td className={`px-3 py-2 whitespace-nowrap ${diff!=null&&diff<0?'text-red-600':'text-emerald-700'}`}>{fmtPct(r.normal_price,r.requested_price)}</td>
                    <td className="px-3 py-2">
                      <span className={`font-bold text-[9px] uppercase px-2 py-0.5 rounded-full ${isApproved?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-700'}`}>
                        {r.decision}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500">{REASON_LABELS[r.reason_type]||r.reason_type||'—'}</td>
                    <td className="px-3 py-2 text-slate-500 max-w-[150px] truncate">{r.competitor_name||r.other_reason||r.rejection_reason||'—'}</td>
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{r.decided_by||'—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
