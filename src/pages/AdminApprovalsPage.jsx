import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadPendingApprovals, approveSpecialPrice, rejectSpecialPrice, loadPriceApprovalEnabled, setPriceApprovalEnabled } from '../utils/cloudSync.js'

const APPROVE_REASONS = [
  { value: 'competitor',  label: 'Competitor Price',           needsName: true },
  { value: 'bulk',        label: 'Customer Taking Bulk Quantity' },
  { value: 'near_expiry', label: 'Product Near Expiry' },
  { value: 'others',      label: 'Others',                     needsOther: true }
]
const REJECT_REASONS = ['Price too low','Discount exceeds limit','Needs manager sign-off','Incorrect price entered','Others']

export default function AdminApprovalsPage() {
  const { profile } = useAuth()
  const [rows,setRows]   = useState(null)
  const [busyId,setBusy] = useState(null)
  const [toast,setToast] = useState('')
  // Runtime toggle — loaded from DB; admin can flip without redeployment
  const [approvalOn, setApprovalOn]     = useState(true)
  const [toggleBusy, setToggleBusy]     = useState(false)

  useEffect(() => {
    loadPriceApprovalEnabled().then(setApprovalOn).catch(() => {})
  }, [])

  const handleToggle = async () => {
    setToggleBusy(true)
    try {
      const next = !approvalOn
      await setPriceApprovalEnabled(next)
      setApprovalOn(next)
      flash(next ? 'Price Approval is now ON' : 'Price Approval is now OFF')
    } catch (e) {
      console.error(e)
      alert('Could not update setting. Make sure sql/58_price_approval_toggle.sql has been run in Supabase.')
    } finally { setToggleBusy(false) }
  }
  const [approving,setApproving] = useState(null)
  const [reasonType,setReasonType]  = useState('')
  const [competitorName,setCompetitorName] = useState('')
  const [otherReason,setOtherReason]       = useState('')
  const [approvedPrice,setApprovedPrice]   = useState('')  // admin can change the price
  const [rejecting,setRejecting]           = useState(null)
  const [rejectReason,setRejectReason]     = useState('')

  const refresh = () => { setRows(null); loadPendingApprovals().then(setRows).catch(()=>setRows([])) }
  useEffect(()=>{ refresh() },[])
  const flash = (m) => { setToast(m); setTimeout(()=>setToast(''),3000) }

  const groups = useMemo(()=>{
    const m=new Map()
    for(const r of rows||[]){const k=r.orders?.shop_name||'—';if(!m.has(k))m.set(k,[]);m.get(k).push(r)}
    return Array.from(m.entries())
  },[rows])

  const startApprove=(it)=>{setApproving(it);setReasonType('');setCompetitorName('');setOtherReason('');setApprovedPrice(String(it.unit_price ?? ''))}

  const confirmApprove=async()=>{
    if(!reasonType){alert('Please select an approval reason.');return}
    const r=APPROVE_REASONS.find(r=>r.value===reasonType)
    if(r?.needsName&&!competitorName.trim()){alert('Competitor Name is required.');return}
    if(r?.needsOther&&!otherReason.trim()){alert('Reason is required.');return}
    const finalApprovedPrice = approvedPrice !== '' && !isNaN(Number(approvedPrice)) ? Number(approvedPrice) : null
    setBusy(approving.id)
    try{
      await approveSpecialPrice(approving.id,profile?.full_name,profile?.id,{
        reasonType,
        competitorName:competitorName.trim()||undefined,
        otherReason:otherReason.trim()||undefined,
        approvedPrice: finalApprovedPrice
      })
      setRows(prev=>prev.filter(r=>r.id!==approving.id));setApproving(null)
      flash(`Approved ₹${finalApprovedPrice ?? approving.unit_price} for ${approving.product_name}.`)
    }catch(e){console.error(e);alert('Could not approve.')}finally{setBusy(null)}
  }

  const confirmReject=async()=>{
    if(!rejectReason){alert('Please choose a reason.');return}
    setBusy(rejecting.id)
    try{
      await rejectSpecialPrice(rejecting.id,profile?.full_name,profile?.id,rejectReason)
      setRows(prev=>prev.filter(r=>r.id!==rejecting.id));setRejecting(null)
      flash(`Rejected ${rejecting.product_name}.`)
    }catch(e){console.error(e);alert('Could not reject.')}finally{setBusy(null)}
  }

  return(
    <div className="px-3 sm:px-6 pt-4 pb-10 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Price Approvals</h1>
          <p className="text-[12px] text-slate-400">Special/custom prices awaiting Admin sign-off.</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Runtime toggle — turns the entire approval workflow on/off
              without a redeployment. Stored in app_settings table. */}
          <button
            onClick={handleToggle}
            disabled={toggleBusy}
            title={approvalOn ? 'Click to disable price approval' : 'Click to enable price approval'}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${approvalOn ? 'bg-emerald-500' : 'bg-slate-300'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${approvalOn ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
          <span className={`text-xs font-semibold ${approvalOn ? 'text-emerald-700' : 'text-slate-400'}`}>
            {toggleBusy ? '…' : approvalOn ? 'Approval ON' : 'Approval OFF'}
          </span>
          <button onClick={refresh} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 ml-1">Refresh</button>
        </div>
      </div>

      {/* Informational banner when approval is OFF */}
      {!approvalOn && (
        <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
          <p className="text-sm font-semibold text-amber-800">⚠ Price Approval is currently OFF</p>
          <p className="text-xs text-amber-700 mt-0.5">Special prices entered by reps will be accepted without requiring Admin approval. Toggle ON above to re-enable the workflow.</p>
        </div>
      )}

      {rows==null ? (
        <div className="py-16 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin"/></div>
      ) : rows.length===0 ? (
        <div className="py-16 text-center">
          <p className="font-semibold text-slate-600">No prices waiting for approval</p>
          <p className="text-sm text-slate-400 mt-1">Every special-priced line has been decided.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map(([shop,items])=>(
            <div key={shop}>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                {shop}{items[0]?.orders?.route ? `, ${items[0].orders.route}` : ''}
              </p>
              <div className="space-y-2">
                {items.map(it=>{
                  const diff=it.normal_price!=null?it.unit_price-it.normal_price:null
                  const pct=it.normal_price?((diff/it.normal_price)*100).toFixed(1):null
                  const isNeg=diff!=null&&diff<0
                  return(
                    <div key={it.id} className="rounded-2xl bg-white border border-purple-200 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-800 truncate">{it.product_name}</p>
                          <p className="text-[11px] text-slate-400">{it.sales_rep_name||'—'} · Qty {it.qty} {it.unit} · {it.orders?.order_date}</p>
                          <p className="text-[10px] text-slate-400">{it.price_type||'CUSTOM'} price</p>
                        </div>
                        <span className="shrink-0 text-[10px] font-bold text-purple-700 bg-purple-50 px-2 py-1 rounded-lg">SPECIAL PRICE</span>
                      </div>

                      <div className="grid grid-cols-4 gap-1.5 mt-2.5 text-center">
                        {[
                          {label:'Normal',val:`₹${it.normal_price??'—'}`,cls:'border-slate-200'},
                          {label:'Requested',val:`₹${it.unit_price}`,cls:'border-purple-200 bg-purple-50',txt:'text-purple-700'},
                          {label:'Diff ₹',val:diff!=null?`${diff>0?'+':''}₹${diff.toFixed(2)}`:'—',cls:isNeg?'border-red-200 bg-red-50':'border-emerald-200 bg-emerald-50',txt:isNeg?'text-red-700':'text-emerald-700'},
                          {label:'Diff %',val:pct!=null?`${parseFloat(pct)>0?'+':''}${pct}%`:'—',cls:isNeg?'border-red-200 bg-red-50':'border-emerald-200 bg-emerald-50',txt:isNeg?'text-red-700':'text-emerald-700'}
                        ].map(c=>(
                          <div key={c.label} className={`rounded-lg border py-1.5 ${c.cls}`}>
                            <div className={`text-sm font-bold ${c.txt||'text-slate-800'}`}>{c.val}</div>
                            <div className="text-[9px] text-slate-400 uppercase">{c.label}</div>
                          </div>
                        ))}
                      </div>

                      {approving?.id===it.id ? (
                        <div className="mt-2.5 space-y-2">
                          <p className="text-xs font-semibold text-slate-700">Why are you approving this?</p>
                          {/* Approved Price — admin can change the price before approving */}
                          <div>
                            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Approved Price (₹)</label>
                            <div className="flex items-center gap-2 mt-1">
                              <input type="number" value={approvedPrice} onChange={e=>setApprovedPrice(e.target.value)}
                                placeholder={String(approving?.unit_price ?? '')}
                                className="w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500" />
                              {approvedPrice !== '' && Number(approvedPrice) !== approving?.unit_price && (
                                <span className="text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded font-semibold">
                                  Modified from ₹{approving?.unit_price}
                                </span>
                              )}
                              {(approvedPrice === '' || Number(approvedPrice) === approving?.unit_price) && (
                                <span className="text-[10px] text-slate-400">Requested: ₹{approving?.unit_price}</span>
                              )}
                            </div>
                          </div>
                          <select value={reasonType} onChange={e=>{setReasonType(e.target.value);setCompetitorName('');setOtherReason('')}}
                            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500 bg-white">
                            <option value="">Select reason…</option>
                            {APPROVE_REASONS.map(r=><option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                          {reasonType==='competitor'&&<input value={competitorName} onChange={e=>setCompetitorName(e.target.value)} placeholder="Competitor Name *" className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500"/>}
                          {reasonType==='others'&&<input value={otherReason} onChange={e=>setOtherReason(e.target.value)} placeholder="Enter reason *" className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500"/>}
                          <div className="flex gap-2">
                            <button onClick={()=>setApproving(null)} className="flex-1 text-xs font-semibold text-slate-500 border border-slate-200 rounded-lg py-1.5">Cancel</button>
                            <button onClick={confirmApprove} disabled={!!busyId} className="flex-1 text-xs font-bold text-white bg-emerald-600 rounded-lg py-1.5 disabled:bg-slate-300">
                              {busyId===it.id?'…':'✓ Confirm Approve'}
                            </button>
                          </div>
                        </div>
                      ) : rejecting?.id===it.id ? (
                        <div className="mt-2.5 space-y-2">
                          <select value={rejectReason} onChange={e=>setRejectReason(e.target.value)}
                            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500 bg-white">
                            <option value="">Select reject reason…</option>
                            {REJECT_REASONS.map(r=><option key={r} value={r}>{r}</option>)}
                          </select>
                          <div className="flex gap-2">
                            <button onClick={()=>{setRejecting(null);setRejectReason('')}} className="flex-1 text-xs font-semibold text-slate-500 border border-slate-200 rounded-lg py-1.5">Cancel</button>
                            <button onClick={confirmReject} disabled={!!busyId} className="flex-1 text-xs font-bold text-white bg-red-600 rounded-lg py-1.5 disabled:bg-slate-300">
                              {busyId===it.id?'…':'Confirm Reject'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2 mt-2.5">
                          <button onClick={()=>startApprove(it)} disabled={!!busyId} className="flex-1 text-xs font-bold text-white bg-emerald-600 rounded-lg py-2 disabled:bg-slate-300">✓ Approve</button>
                          <button onClick={()=>{setRejecting(it);setRejectReason('')}} disabled={!!busyId} className="flex-1 text-xs font-bold text-red-600 border border-red-200 rounded-lg py-2">✕ Reject</button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {toast&&<div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg">{toast}</div>}
    </div>
  )
}
