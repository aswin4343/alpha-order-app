import { memo } from 'react'
import QtyStepper from './QtyStepper.jsx'

// A single product row with a quantity stepper. Memoised so unrelated
// quantity changes don't re-render every card in a long list.
function ProductCard({ product, qty, onQty }) {
  const selected = qty > 0
  return (
    <div
      className={`rounded-2xl bg-white shadow-card px-4 py-3 flex items-center gap-3 border ${
        selected ? 'border-brand-500' : 'border-transparent'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-[15px] leading-snug font-medium text-slate-800 break-words">
          {product.name}
        </p>
        {(product.brand || product.unit) && (
          <p className="text-xs text-slate-400 mt-0.5">
            {[product.brand, product.unit].filter(Boolean).join(' • ')}
          </p>
        )}
      </div>
      <QtyStepper qty={qty} onChange={(v) => onQty(product.id, v)} />
    </div>
  )
}

export default memo(ProductCard)
