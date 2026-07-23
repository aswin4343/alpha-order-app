import { useMemo } from 'react'

// Multi-word AND search with simple relevance ranking.
// Every query word must appear somewhere in the item's searchable text.
// Ranking: exact prefix match on the name > word-boundary match > contains.
export function useSearch(items, query, getText, limit = 60) {
  return useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, limit)

    const words = q.split(/\s+/).filter(Boolean)
    const results = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const text = getText(item).toLowerCase()
      let ok = true
      for (const w of words) {
        if (!text.includes(w)) {
          ok = false
          break
        }
      }
      if (!ok) continue

      // Score: lower is better.
      let score = 3
      if (text.startsWith(q)) score = 0
      else if (text.includes(' ' + q)) score = 1
      else if (words.every((w) => text.startsWith(w) || text.includes(' ' + w))) score = 2

      results.push({ item, score, idx: i })
      // Early exit once we have plenty of candidates to rank.
      if (results.length > limit * 8) break
    }

    results.sort((a, b) => a.score - b.score || a.idx - b.idx)
    return results.slice(0, limit).map((r) => r.item)
  }, [items, query, getText, limit])
}
