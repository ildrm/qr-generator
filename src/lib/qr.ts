import qrcode from 'qrcode-generator'
import type { DesignStyle } from './storage'

export type Matrix = { size: number; dark: boolean[][] }
export type RenderOptions = DesignStyle & { label?: string }
const margin = 4

export function encodeQr(value: string, level: 'L'|'M'|'Q'|'H' = 'M'): Matrix {
  if (!value) throw new Error('Enter content first.')
  // qrcode-generator supports Model 2 versions 1–40; 0 selects the smallest fit.
  qrcode.stringToBytes = (text: string) => Array.from(new TextEncoder().encode(text))
  try {
    const qr = qrcode(0, level)
    qr.addData(value, 'Byte')
    qr.make()
    const size = qr.getModuleCount()
    return { size, dark: Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => qr.isDark(y, x))) }
  } catch (error) {
    if (/overflow|too long|code length/i.test(String(error))) throw new Error('Content exceeds QR capacity. Shorten it or use a lower error-correction level.')
    throw error
  }
}

const esc = (value: string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!))
const hex = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'
export const safeFilename = (value: string) => (value.normalize('NFKC').replace(/[\x00-\x1f<>:"/\\|?*]+/g, '-').replace(/^\.+|\.+$/g, '').trim().slice(0, 70) || 'qr-code') // eslint-disable-line no-control-regex
export const totalModules = (matrix: Matrix) => matrix.size + 2 * margin
export const moduleSizeMm = (matrix: Matrix, printMm: number) => printMm / totalModules(matrix)

function finderCell(x: number, y: number, n: number) {
  return (x < 7 && y < 7) || (x >= n-7 && y < 7) || (x < 7 && y >= n-7)
}
export function isFunctionalCell(x: number, y: number, n: number) {
  if (finderCell(x,y,n) || x === 6 || y === 6) return true
  if ((x <= 8 && (y <= 8 || y >= n-8)) || (y <= 8 && x >= n-8)) return true // format bits
  if (n >= 45 && ((x < 6 && y >= n-11 && y <= n-9) || (y < 6 && x >= n-11 && x <= n-9))) return true // version bits
  const version=(n-17)/4
  if (version < 2) return false
  const count=Math.floor(version/7)+2
  const step=version===32?26:Math.ceil((version*4+count*2+1)/(count*2-2))*2
  const positions=[6,...Array.from({length:count-1},(_,i)=>n-7-(count-2-i)*step)]
  return positions.some(cx=>positions.some(cy=>!(cx===6&&cy===6)&&!(cx===6&&cy===n-7)&&!(cx===n-7&&cy===6)&&Math.abs(x-cx)<=2&&Math.abs(y-cy)<=2))
}

export function renderSvg(matrix: Matrix, style: RenderOptions, sizePx = style.size || 512): string {
  const n = matrix.size, units = totalModules(matrix)
  const label = style.frame?.label || style.label || ''
  const labelHeight = label ? 4 : 0
  const bg = hex(style.background), fg = hex(style.foreground)
  const fill = style.gradient ? 'url(#ink)' : fg
  const defs = style.gradient ? `<defs><linearGradient id="ink" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hex(style.gradient.from)}"/><stop offset="1" stop-color="${hex(style.gradient.to)}"/></linearGradient></defs>` : ''
  const shapes: string[] = []
  for (let y=0; y<n; y++) for (let x=0; x<n; x++) if (matrix.dark[y][x]) {
    const xx=x+margin, yy=y+margin
    const functional=isFunctionalCell(x,y,n)
    const mode=functional ? (finderCell(x,y,n) && style.finderStyle === 'rounded' ? 'rounded' : 'square') : style.moduleStyle
    if (mode === 'dots') shapes.push(`<circle cx="${xx+.5}" cy="${yy+.5}" r=".43"/>`)
    else shapes.push(`<rect x="${xx}" y="${yy}" width="1" height="1"${mode==='rounded' ? ' rx=".22"' : ''}/>`)
  }
  const logoSize = style.logo ? Math.min(n * .16, 7) : 0
  const lx=(units-logoSize)/2, ly=(units-logoSize)/2
  const logo = style.logo && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(style.logo)
    ? `<rect x="${lx-.7}" y="${ly-.7}" width="${logoSize+1.4}" height="${logoSize+1.4}" rx=".8" fill="${bg}"/><image href="${style.logo}" x="${lx}" y="${ly}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>` : ''
  const background = style.transparent ? '' : `<rect width="${units}" height="${units+labelHeight}" fill="${bg}"/>`
  const caption = label ? `<text x="${units/2}" y="${units+2.1}" text-anchor="middle" font-family="Arial, sans-serif" font-size="1.75" font-weight="600" fill="${fg}">${esc(label.slice(0, 32))}</text>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(sizePx)}" height="${Math.round(sizePx*(units+labelHeight)/units)}" viewBox="0 0 ${units} ${units+labelHeight}" role="img" aria-label="QR code">${defs}${background}<g fill="${fill}">${shapes.join('')}</g>${logo}${caption}</svg>`
}

export async function svgToPng(svg: string, width: number, background?: string): Promise<Blob> {
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = Math.round(width * image.height / image.width)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas is unavailable in this browser.')
    if (background) { context.fillStyle = background; context.fillRect(0,0,canvas.width,canvas.height) }
    context.drawImage(image,0,0,canvas.width,canvas.height)
    return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value ? resolve(value) : reject(new Error('Could not create PNG.')), 'image/png'))
  } finally { URL.revokeObjectURL(url) }
}

export function colorContrast(foreground: string, background: string): number {
  const luminance=(v:string)=> { const c=[1,3,5].map(i=>parseInt(v.slice(i,i+2),16)/255).map(x=>x<=.04045 ? x/12.92 : ((x+.055)/1.055)**2.4); return c[0]*.2126+c[1]*.7152+c[2]*.0722 }
  const a=luminance(hex(foreground)), b=luminance(hex(background))
  return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)
}
