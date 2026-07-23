import { useEffect, useState } from 'react'

// Returns a debounced copy of `value`, updating at most every `delay` ms.
export function useDebounce(value, delay = 120) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
