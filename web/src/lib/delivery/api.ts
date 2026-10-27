import { errMsg, supabase } from '../supabase'
import type { OrderPayment, PayStatus } from '../online'

/**
 * Διανομείς (0007): η σελίδα του διανομέα (/d/:token, χωρίς λογαριασμό),
 * το «ποιος τη φέρνει / πού είναι» του πελάτη, και ο χάρτης.
 */

export interface DriverOrder {
  id: string
  order_no: number
  status: 'accepted' | 'done'
  customer_name: string
  phone: string
  address: string | null
  notes: string | null
  total: number
  payment: OrderPayment
  pay_status: PayStatus
  created_at: string
  accepted_at: string | null
  ready_minutes: number | null
  done_at: string | null
  lines: { name: string; qty: number; line_no: number; parent_line: number | null; note: string | null }[]
}

export interface DriverApp {
  driver: { name: string }
  shop: { name: string; phone: string | null; tracking: boolean }
  ready: DriverOrder[]
  mine: DriverOrder[]
  delivered_today: number
  cash_open: number
}

export interface TrackInfo {
  driver: string | null
  delivered_at: string | null
  pos: { lat: number; lng: number; acc: number | null; at: string } | null
}

/** Ο διανομέας στη λίστα του μαγαζιού (v_driver_today) */
export interface DriverRow {
  company_id: string
  driver_id: string
  name: string
  phone: string | null
  is_active: boolean
  has_link: boolean
  last_at: string | null
  on_way: number
  delivered_today: number
  cash_open: number
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(errMsg(error))
  return data as T
}

export const loadDriverApp = (token: string) => rpc<DriverApp>('driver_app', { p_token: token })
export const driverTake = (token: string, order: string) => rpc<{ order_no: number }>('driver_take', { p_token: token, p_order: order })
export const driverRelease = (token: string, order: string) => rpc<{ order_no: number }>('driver_release', { p_token: token, p_order: order })
export const driverDelivered = (token: string, order: string) =>
  rpc<{ order_no: number; cash: number }>('driver_delivered', { p_token: token, p_order: order })
export const driverPing = (token: string, lat: number, lng: number, acc: number | null) =>
  rpc<boolean>('driver_ping', { p_token: token, p_lat: lat, p_lng: lng, p_acc: acc })
export const loadTrack = (token: string) => rpc<TrackInfo | null>('order_track', { p_token: token })

/** Πλοήγηση στη διεύθυνση (Google Maps: ανοίγει την εφαρμογή στο κινητό) */
export const navUrl = (address: string, city?: string | null): string =>
  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(city && !address.includes(city) ? `${address}, ${city}` : address)}&travelmode=driving`

/** Σύνδεσμος του διανομέα */
export const driverUrl = (token: string, origin = typeof window !== 'undefined' ? window.location.origin : ''): string =>
  `${origin}/d/${token}`
