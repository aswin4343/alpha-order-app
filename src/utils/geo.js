// Alpha Trade Links distribution hub (ALPHA TRADE LINKS, from Google Maps).
export const HUB = { latitude: 8.7185867, longitude: 76.8056374 }

// Haversine straight-line distance in kilometres between two lat/long points.
export function distanceKm(a, b) {
  if (
    a?.latitude == null ||
    a?.longitude == null ||
    b?.latitude == null ||
    b?.longitude == null
  ) {
    return null
  }
  const R = 6371 // earth radius km
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Distance from the hub to a point.
export function distanceFromHub(point) {
  return distanceKm(HUB, point)
}

// Sort a list of items (each with latitude/longitude) nearest-to-hub first.
// Items without coordinates go to the end (location not captured yet).
export function sortByHubDistance(items) {
  return [...items]
    .map((it) => ({ it, d: distanceFromHub(it) }))
    .sort((a, b) => {
      if (a.d == null && b.d == null) return 0
      if (a.d == null) return 1
      if (b.d == null) return -1
      return a.d - b.d
    })
    .map(({ it, d }) => ({ ...it, _distanceKm: d }))
}
