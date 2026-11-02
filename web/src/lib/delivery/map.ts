/** Χάρτης χωρίς βιβλιοθήκη: 3×3 πλακίδια OpenStreetMap γύρω από ένα σημείο */

export const TILE = 256

/** Πλακίδιο (x, y) και θέση μέσα σε αυτό (px), για zoom z (Web Mercator) */
export function tileOf(lat: number, lng: number, z: number): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z
  const fx = ((lng + 180) / 360) * n
  const r = (lat * Math.PI) / 180
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
  const x = Math.floor(fx)
  const y = Math.floor(fy)
  return { x, y, px: Math.round((fx - x) * TILE), py: Math.round((fy - y) * TILE) }
}

export const tileUrl = (z: number, x: number, y: number): string => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
