import { TILE, tileOf, tileUrl } from '../../lib/delivery/map'

/**
 * Πού είναι ο διανομέας: 3×3 πλακίδια OpenStreetMap γύρω του και μια
 * κουκκίδα. Χωρίς βιβλιοθήκη χαρτών, χωρίς κλειδί.
 */
export function TrackMap({ lat, lng, zoom = 16 }: { lat: number; lng: number; zoom?: number }) {
  const t = tileOf(lat, lng, zoom)
  // το σημείο στο κέντρο του κουτιού: μετακινούμε το πλέγμα των 3×3
  const left = -(TILE + t.px)
  const top = -(TILE + t.py)
  const tiles: { x: number; y: number; dx: number; dy: number }[] = []
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles.push({ x: t.x + dx, y: t.y + dy, dx: dx + 1, dy: dy + 1 })
  return (
    <div className="relative h-56 overflow-hidden rounded-md bg-stone-200" aria-label="Χάρτης με τη θέση του διανομέα">
      <div className="absolute" style={{ left: '50%', top: '50%' }}>
        <div className="absolute" style={{ left, top, width: TILE * 3, height: TILE * 3 }}>
          {tiles.map((p) => (
            <img key={`${p.x}-${p.y}`} src={tileUrl(zoom, p.x, p.y)} alt="" draggable={false} width={TILE} height={TILE}
              className="absolute max-w-none select-none" style={{ left: p.dx * TILE, top: p.dy * TILE }} />
          ))}
        </div>
        <div className="absolute -translate-x-1/2 -translate-y-1/2 text-3xl drop-shadow" aria-hidden="true">🛵</div>
      </div>
      <div className="absolute bottom-0 right-0 bg-white/80 px-1 text-[10px] text-stone-700">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap</a>
      </div>
    </div>
  )
}
