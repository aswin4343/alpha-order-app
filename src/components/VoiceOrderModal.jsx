import { useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { parseVoiceOrder } from '../utils/voiceParser.js'
import { CloseIcon, CheckIcon } from './Icons.jsx'

// Browser speech recognition (free, on-device where supported).
const SR = typeof window !== 'undefined'
  ? window.SpeechRecognition || window.webkitSpeechRecognition
  : null

const UNITS = ['Piece', 'Box']

/**
 * Voice Order flow:
 *   record -> live transcript -> parse -> review (edit/confirm) -> apply
 * Never auto-submits. The rep confirms every line before it fills the order.
 */
export default function VoiceOrderModal({ onClose, onApply }) {
  const { products } = useApp()
  const [phase, setPhase] = useState(SR ? 'idle' : 'unsupported') // idle|recording|processing|review
  const [transcript, setTranscript] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [result, setResult] = useState({ matched: [], unmatched: [] })

  const recRef = useRef(null)
  const timerRef = useRef(null)
  const finalRef = useRef('')

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
  }

  const start = useCallback(() => {
    if (!SR) return
    finalRef.current = ''
    setTranscript('')
    setSeconds(0)
    const rec = new SR()
    rec.lang = 'en-IN' // Indian-accented English; product names are English
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) finalRef.current += t + ' '
        else interim += t
      }
      setTranscript(finalRef.current + interim)
    }
    rec.onerror = () => {}
    rec.onend = () => {
      // If we're still meant to be recording, the engine auto-stopped; keep text.
    }
    recRef.current = rec
    rec.start()
    setPhase('recording')
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        if (s >= 60) {
          finish()
          return 60
        }
        return s + 1
      })
    }, 1000)
  }, [])

  const finish = useCallback(() => {
    stopTimer()
    try {
      recRef.current && recRef.current.stop()
    } catch (e) {
      /* ignore */
    }
    setPhase('processing')
    // Small delay so the final transcript settles, then parse locally.
    setTimeout(() => {
      const text = finalRef.current || transcript
      const parsed = parseVoiceOrder(text, products)
      setResult(parsed)
      setPhase('review')
    }, 500)
  }, [products, transcript])

  useEffect(() => () => {
    stopTimer()
    try { recRef.current && recRef.current.stop() } catch (e) {}
  }, [])

  const updateLine = (idx, patch) =>
    setResult((r) => ({
      ...r,
      matched: r.matched.map((m, i) => (i === idx ? { ...m, ...patch } : m))
    }))

  const removeLine = (idx) =>
    setResult((r) => ({ ...r, matched: r.matched.filter((_, i) => i !== idx) }))

  const applyOrder = () => {
    // Hand back {productId, qty, unit} for each confirmed line.
    onApply(result.matched.map((m) => ({ id: m.product.id, qty: m.qty, unit: m.unit })))
  }

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <h2 className="font-bold text-slate-800">🎤 Voice Order</h2>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 scroll-area flex-1">
          {phase === 'unsupported' && (
            <div className="text-center py-10">
              <p className="text-slate-600 font-medium">
                Voice input isn't supported on this browser.
              </p>
              <p className="text-sm text-slate-400 mt-2">
                Try Chrome on Android, or use manual search.
              </p>
            </div>
          )}

          {phase === 'idle' && (
            <div className="text-center py-8">
              <p className="text-slate-600 mb-6">
                Tap the mic and speak the order naturally.
                <br />
                <span className="text-sm text-slate-400">
                  e.g. “two boxes gigi lemon lime, five cornix cheese puffcorn”
                </span>
              </p>
              <button
                onClick={start}
                className="h-24 w-24 rounded-full bg-brand-600 text-white text-4xl mx-auto flex items-center justify-center active:bg-brand-700 shadow-lg shadow-brand-600/30"
              >
                🎤
              </button>
            </div>
          )}

          {phase === 'recording' && (
            <div className="text-center py-6">
              {/* Live "waveform" — animated bars */}
              <div className="flex items-end justify-center gap-1 h-16 mb-4">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <span
                    key={i}
                    className="w-1.5 bg-brand-500 rounded-full animate-pulse"
                    style={{
                      height: `${20 + Math.abs(Math.sin(i)) * 40}px`,
                      animationDelay: `${i * 90}ms`
                    }}
                  />
                ))}
              </div>
              <p className="text-2xl font-bold text-slate-800 tabular-nums">{mmss}</p>
              <p className="text-xs text-slate-400 mb-4">Listening… speak your order</p>

              <div className="min-h-[60px] rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 text-left text-sm text-slate-700 mb-4">
                {transcript || <span className="text-slate-400">Transcript will appear here…</span>}
              </div>

              <button
                onClick={finish}
                className="w-full rounded-xl bg-red-500 text-white py-3.5 font-bold active:bg-red-600"
              >
                ⏹ Stop &amp; Process
              </button>
            </div>
          )}

          {phase === 'processing' && (
            <div className="text-center py-16">
              <div className="h-10 w-10 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin mx-auto mb-4" />
              <p className="text-slate-600 font-medium">Processing…</p>
            </div>
          )}

          {phase === 'review' && (
            <div>
              <div className="mb-3 rounded-xl bg-slate-50 border border-slate-100 px-3 py-2">
                <p className="text-[11px] text-slate-400 uppercase font-semibold mb-1">You said</p>
                <p className="text-sm text-slate-600">{transcript || '—'}</p>
              </div>

              {result.matched.length > 0 && (
                <>
                  <p className="text-xs font-semibold text-brand-600 mb-2">
                    MATCHED ({result.matched.length}) — review before adding
                  </p>
                  <div className="space-y-2 mb-4">
                    {result.matched.map((m, i) => (
                      <div
                        key={i}
                        className={`rounded-xl border px-3 py-2.5 ${
                          m.needsReview ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-800">{m.product.name}</p>
                            <p className="text-[11px] text-slate-400">
                              heard “{m.spoken}” · {Math.round(m.confidence * 100)}% match
                              {m.needsReview && (
                                <span className="text-amber-700 font-semibold"> · check this</span>
                              )}
                            </p>
                          </div>
                          <button
                            onClick={() => removeLine(i)}
                            className="text-slate-300 shrink-0"
                            aria-label="Remove"
                          >
                            <CloseIcon className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <select
                            value={m.unit}
                            onChange={(e) => updateLine(i, { unit: e.target.value })}
                            className="h-9 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 outline-none"
                          >
                            {UNITS.map((u) => (
                              <option key={u} value={u}>{u}</option>
                            ))}
                          </select>
                          <div className="flex items-center gap-1 ml-auto">
                            <button
                              onClick={() => updateLine(i, { qty: Math.max(1, m.qty - 1) })}
                              className="h-9 w-9 rounded-lg bg-slate-100 text-slate-700 font-bold"
                            >
                              −
                            </button>
                            <input
                              value={m.qty}
                              onChange={(e) =>
                                updateLine(i, {
                                  qty: Math.max(1, parseInt(e.target.value.replace(/\D/g, '') || '1', 10))
                                })
                              }
                              inputMode="numeric"
                              className="h-9 w-12 text-center rounded-lg border border-slate-200 text-sm font-semibold"
                            />
                            <button
                              onClick={() => updateLine(i, { qty: m.qty + 1 })}
                              className="h-9 w-9 rounded-lg bg-brand-600 text-white font-bold"
                            >
                              +
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {result.unmatched.length > 0 && (
                <>
                  <p className="text-xs font-semibold text-red-500 mb-2">
                    NOT MATCHED ({result.unmatched.length}) — add manually after
                  </p>
                  <div className="space-y-1.5 mb-4">
                    {result.unmatched.map((u, i) => (
                      <div key={i} className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm text-slate-600">
                        “{u.spoken}” · {u.qty} {u.unit}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {result.matched.length === 0 && result.unmatched.length === 0 && (
                <p className="text-center text-slate-400 py-8 text-sm">
                  Nothing recognised. Try again and speak clearly.
                </p>
              )}

              <button
                onClick={start}
                className="w-full rounded-xl border border-slate-200 py-3 font-semibold text-slate-600 mb-2"
              >
                🎤 Record again
              </button>
            </div>
          )}
        </div>

        {phase === 'review' && result.matched.length > 0 && (
          <div className="p-4 border-t border-slate-100 safe-bottom">
            <button
              onClick={applyOrder}
              className="w-full rounded-xl bg-brand-600 text-white py-4 font-bold active:bg-brand-700 flex items-center justify-center gap-2"
            >
              <CheckIcon className="h-5 w-5" />
              Add {result.matched.length} item{result.matched.length > 1 ? 's' : ''} to order
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
