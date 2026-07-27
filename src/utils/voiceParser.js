// ---------------------------------------------------------------------------
// VOICE ORDER PARSER (fully local — no AI API, no backend, no cost)
//
// Turns a spoken transcript like:
//   "two boxes gigi classic, five pieces cornix cheese popcorn, ten veeba mayo"
// into structured line items matched against the product catalogue, using the
// same fuzzy-matching idea as the product search plus number-word parsing.
// ---------------------------------------------------------------------------

// Spoken number words -> digits (covers 0-100 the practical way).
const NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  // common Malayalam quantity words, transliterated (best-effort)
  onnu: 1, rendu: 2, randu: 2, moonu: 3, moonnu: 3, naalu: 4, anchu: 5,
  aaru: 6, ezhu: 7, ettu: 8, onpathu: 9, pathu: 10
}

// Spoken unit words -> the app's supported unit ('Piece' | 'Box').
// The app currently books in Piece/Box; other spoken units map to the nearest.
const UNIT_WORDS = {
  piece: 'Piece', pieces: 'Piece', pcs: 'Piece', pc: 'Piece', nos: 'Piece',
  packet: 'Piece', packets: 'Piece', pouch: 'Piece', pouches: 'Piece',
  sachet: 'Piece', sachets: 'Piece', bottle: 'Piece', bottles: 'Piece',
  can: 'Piece', cans: 'Piece', jar: 'Piece', jars: 'Piece',
  box: 'Box', boxes: 'Box', carton: 'Box', cartons: 'Box', case: 'Box'
}

// Words that carry no product meaning — dropped before matching.
const STOP = new Set([
  'and', 'the', 'a', 'an', 'of', 'please', 'also', 'add', 'order',
  'give', 'me', 'want', 'need', 'get', 'some', 'gram', 'grams', 'gm', 'g',
  'kg', 'ml', 'litre', 'liter', 'l'
])

function wordToNumber(tokens) {
  // Combine sequences like "twenty five" -> 25, "one hundred" -> 100.
  let total = 0
  let current = 0
  let used = 0
  for (const t of tokens) {
    const n = NUM_WORDS[t]
    if (n == null) break
    if (n === 100) {
      current = (current || 1) * 100
    } else {
      current += n
    }
    used++
  }
  total += current
  return { value: total, used }
}

// Normalise for matching: lowercase alphanumerics only.
function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// Score how well a spoken phrase matches a product name (0..1).
// Rewards: shared words, prefix hits, and coverage of the spoken phrase.
function scoreMatch(phraseWords, product) {
  const pWords = norm(product.name).split(/\s+/).filter(Boolean)
  if (pWords.length === 0 || phraseWords.length === 0) return 0
  const pSet = new Set(pWords)

  let hits = 0
  for (const w of phraseWords) {
    if (w.length < 2) continue
    if (pSet.has(w)) {
      hits += 1
    } else if (pWords.some((pw) => pw.startsWith(w) || w.startsWith(pw))) {
      hits += 0.6 // partial / prefix (handles "mayo" -> "mayonnaise")
    }
  }
  // Coverage of what was spoken, lightly weighted by product-word coverage.
  const spokenCoverage = hits / phraseWords.length
  const productCoverage = hits / pWords.length
  return spokenCoverage * 0.75 + productCoverage * 0.25
}

// Split the transcript into segments by commas / "and" / natural pauses.
function segments(transcript) {
  return transcript
    .replace(/\band\b/gi, ',')
    .split(/[,;]|\.(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Parse a transcript into matched + unmatched line items.
 * @param {string} transcript
 * @param {Array} products  catalogue [{id,name,slabs,...}]
 * @param {number} threshold confidence cut-off (default 0.34)
 */
export function parseVoiceOrder(transcript, products, threshold = 0.34) {
  const matched = []
  const unmatched = []
  if (!transcript || !transcript.trim()) return { matched, unmatched }

  for (const seg of segments(transcript)) {
    let tokens = norm(seg).split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue

    // 1) Quantity (leading number words or digits, possibly "twenty five")
    let qty = 1
    const num = wordToNumber(tokens)
    if (num.used > 0) {
      qty = num.value || 1
      tokens = tokens.slice(num.used)
    } else if (/^\d+$/.test(tokens[0])) {
      qty = parseInt(tokens[0], 10)
      tokens = tokens.slice(1)
    }

    // 2) Unit (anywhere in the segment)
    let unit = 'Piece'
    tokens = tokens.filter((t) => {
      if (UNIT_WORDS[t]) {
        unit = UNIT_WORDS[t]
        return false
      }
      return true
    })

    // 2b) Trailing quantity: if no leading number was found, check the end.
    if (num.used === 0 && !/^\d+$/.test((seg.match(/^\s*(\d+)/) || [])[1] || '')) {
      const last = tokens[tokens.length - 1]
      if (last && NUM_WORDS[last] != null) {
        qty = NUM_WORDS[last]
        tokens = tokens.slice(0, -1)
      } else if (last && /^\d+$/.test(last)) {
        qty = parseInt(last, 10)
        tokens = tokens.slice(0, -1)
      }
    }

    // 3) Remaining words = the product phrase
    const phraseWords = tokens.filter((t) => !STOP.has(t) && NUM_WORDS[t] == null)
    if (phraseWords.length === 0) continue

    // 4) Best product match
    let best = null
    let bestScore = 0
    let second = 0
    for (const p of products) {
      const sc = scoreMatch(phraseWords, p)
      if (sc > bestScore) {
        second = bestScore
        bestScore = sc
        best = p
      } else if (sc > second) {
        second = sc
      }
    }

    const spoken = phraseWords.join(' ')
    if (best && bestScore >= threshold) {
      matched.push({
        product: best,
        qty: Math.max(1, qty),
        unit,
        confidence: Math.min(1, bestScore),
        // Flag for explicit rep review when it's a close call OR not highly confident.
        needsReview: bestScore - second < 0.1 || bestScore < 0.55,
        spoken
      })
    } else {
      unmatched.push({ spoken, qty: Math.max(1, qty), unit })
    }
  }

  // Merge duplicates (same product spoken twice) by summing quantity.
  const byId = new Map()
  const finalMatched = []
  for (const m of matched) {
    if (byId.has(m.product.id)) {
      byId.get(m.product.id).qty += m.qty
    } else {
      byId.set(m.product.id, m)
      finalMatched.push(m)
    }
  }

  return { matched: finalMatched, unmatched }
}
