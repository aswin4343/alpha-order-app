import { WhatsAppIcon, CopyIcon } from './Icons.jsx'

// Sticky bottom bar: order totals, Copy Order, and SEND ORDER.
export default function OrderSummaryBar({
  customer,
  productCount,
  totalQty,
  disabled,
  onSend,
  onCopy
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

          <div className="flex gap-2">
            <button
              onClick={onCopy}
              disabled={disabled}
              aria-label="Copy order"
              className={`h-[52px] w-[52px] shrink-0 rounded-xl flex items-center justify-center border ${
                disabled
                  ? 'border-slate-100 text-slate-300'
                  : 'border-slate-200 text-slate-600 active:bg-slate-50'
              }`}
            >
              <CopyIcon className="h-5 w-5" />
            </button>

            <button
              onClick={onSend}
              disabled={disabled}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-4 text-base font-bold transition active:scale-[0.99] ${
                disabled
                  ? 'bg-slate-100 text-slate-400'
                  : 'bg-brand-600 text-white active:bg-brand-700 shadow-lg shadow-brand-600/20'
              }`}
            >
              <WhatsAppIcon className="h-6 w-6" />
              SEND ORDER
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
