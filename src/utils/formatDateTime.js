// Date-time display helpers (v229). Pure; unit-tested in Node.

/**
 * "DD/MM/YYYY, HH:MM AM/PM" in India time (Asia/Kolkata), whatever the
 * device's own timezone. Returns '—' for empty / invalid values, so a time
 * that was never recorded is never replaced by some other date.
 */
export function formatDateTimeIST(value) {
  if (value == null || value === '') return '—'
  // Normalise Postgres/Supabase timestamps for every browser (older iOS Safari
  // rejects a space separator, >3 fractional digits and a bare "+00" offset).
  const iso = typeof value === 'string'
    ? value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00')
    : value
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    }).formatToParts(d).map((p) => [p.type, p.value])
  )
  const hour = parts.hour === '00' ? '12' : parts.hour
  return `${parts.day}/${parts.month}/${parts.year}, ${hour}:${parts.minute} ${String(parts.dayPeriod || '').toUpperCase()}`
}
