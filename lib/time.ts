import { START_MS } from './plant'

const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function fmt(h: number) {
  const d = new Date(START_MS + Math.round(h) * 3600000)
  return `${D[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')} ${M[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:00`
}
export function iso(h: number) {
  return new Date(START_MS + Math.round(h) * 3600000).toISOString().slice(0, 16)
}
