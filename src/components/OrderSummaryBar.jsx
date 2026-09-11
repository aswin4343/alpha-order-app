import { CopyIcon } from './Icons.jsx'

// Sticky bottom bar: order totals and COPY ORDER (the primary submission action).
// WhatsApp send has been removed — the workflow is now: add products → Copy Order
// → location captured → order sent to Billing. After Copy Order + location capture
// the session clears automatically, which locks product entry on that screen.
// Further additions to a submitted order go through My Performance → Orders Taken → ADD-ON.
export default function OrderSummaryBar({
  customer,
  productCount,
  totalQty,
  disabled,
  onSend,
  onCopy,
  isVisit = false,
  visitReady = false,
  onSaveVisit
}) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-30">
      <div className="mx-auto max-w-md px-3 pb-3 safe-bottom">
        <div className="rounded-2xl bg-white shadow-pop border border-slate-100 p-3">
          <div className="flex items-center justify-between mb-2.5 px-1">
            <div className="min-w-0">
              <p className="text-[13px] text-slate-400 leading-tight">Customer</p>
              <p className="text-sm font-semibold text-slate-800 truncate">
                {customer ? customer.name : 'Not selected'}
              </p>
              {customer?.route && (
                <p className="text-[11px] text-slate-400 truncate">{customer.route}</p>
              )}
            </div>
            <div className="flex gap-4 text-right shrink-0 ml-3">
              <div>
                <p className="text-[13px] text-slate-400 leading-tight">Items</p>
                <p className="text-base font-bold text-slate-800">{productCount}</p>
              </div>
              <div>
                <p className="text-[13px] text-slate-400 leading-tight">Qty</p>
                <p className="text-base font-bold text-slate-800">{totalQty}</p>
              </div>
            </div>
          </div>

          {isVisit ? (
            <button
              onClick={onSaveVisit}
              disabled={!visitReady}
              className={`w-full flex items-center justify-center gap-2 rounded-xl py-4 text-base font-bold transition active:scale-[0.99] ${
                visitReady
                  ? 'bg-amber-500 text-white active:bg-amber-600 shadow-lg shadow-amber-500/20'
                  : 'bg-slate-100 text-slate-400'
              }`}
            >
              SAVE VISIT (NO ORDER)
            </button>
          ) : (
            // Single "COPY ORDER" button — saves the order to the database,
            // captures GPS location, copies the order text to clipboard, then
            // clears the session (which locks product entry on this screen).
            // To add more products to an already-submitted order, the rep must
            // use My Performance → Orders Taken → + ADD-ON.
            <button
              onClick={onCopy}
              disabled={disabled}
              className={`w-full flex items-center justify-center gap-2 rounded-xl py-4 text-base font-bold transition active:scale-[0.99] ${
                disabled
                  ? 'bg-slate-100 text-slate-400'
                  : 'bg-brand-600 text-white active:bg-brand-700 shadow-lg shadow-brand-600/20'
              }`}
            >
              <CopyIcon className="h-5 w-5" />
              COPY ORDER
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
