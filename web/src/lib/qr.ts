import qrcode from 'qrcode-generator'

/** QR ως SVG (κλιμακώνεται στο πλάτος του κουτιού του). Μέτρια διόρθωση: αντέχει λεκέδες στη σακούλα. */
export function qrSvg(text: string): string {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}
