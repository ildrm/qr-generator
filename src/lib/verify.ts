import { colorContrast, svgToPng, type Matrix } from './qr'
import type { DesignStyle } from './storage'

export type ScanState = { kind: 'verified'|'review'|'failed'|'capacity'|'pending'; message: string; reason?: string }
let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, (value: { decoded: string|null; match: boolean; error?: string }) => void>()
function verifier() {
  if (!worker) {
    worker = new Worker(new URL('../workers/verify.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{id:number;decoded:string|null;match:boolean;error?:string}>) => {
      pending.get(event.data.id)?.(event.data); pending.delete(event.data.id)
    }
    worker.onerror = (event) => {
      for (const resolve of pending.values()) resolve({ decoded: null, match: false, error: `Verification worker could not load: ${event.message}` })
      pending.clear()
      worker?.terminate()
      worker = undefined
    }
  }
  return worker
}
export async function verifyPng(blob: Blob, expected: string, style: DesignStyle, matrix: Matrix, printMm = 25): Promise<ScanState> {
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = (matrix.size+8)*10
    canvas.height = Math.round(bitmap.height * canvas.width / bitmap.width)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas unavailable')
    if (style.transparent) { context.fillStyle='#ffffff'; context.fillRect(0,0,canvas.width,canvas.height) }
    context.drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close()
    const image = context.getImageData(0,0,canvas.width,canvas.height)
    const decoded = await new Promise<{decoded:string|null;match:boolean;error?:string}>(resolve => {
      const id=++nextId; pending.set(id,resolve); verifier().postMessage({id,data:image.data,width:image.width,height:image.height,expected}, [image.data.buffer])
      window.setTimeout(()=>{if(pending.has(id)){pending.delete(id);resolve({decoded:null,match:false,error:'Verification timed out.'})}},8000)
    })
    if (!decoded.match) return { kind:'failed', message:'Could not verify this design', reason: decoded.error || (decoded.decoded ? 'The scanner read different content. Try the safer style.' : 'Try darker colors, square modules, or remove the logo.') }
    const contrast=style.gradient
      ? Math.min(colorContrast(style.gradient.from,style.background),colorContrast(style.gradient.to,style.background))
      : colorContrast(style.foreground,style.background)
    const small=printMm/(matrix.size+8)<.35
    if (contrast<4.5 || small || style.transparent) return { kind:'review', message:'Decoded; print conditions need review', reason: [contrast<4.5?'Low color contrast':null,small?'Small printed modules':null,style.transparent?'Check the final background':null].filter(Boolean).join(' · ') }
    return { kind:'verified', message:'Verified by decoder' }
  } catch { return { kind:'failed', message:'Could not verify in this browser', reason:'Canvas, image decoding, or the verification worker may be unavailable.' } }
}

export async function verifySvg(svg: string, expected: string, style: DesignStyle, matrix: Matrix, printMm = 25): Promise<ScanState> {
  try {
    const blob = await svgToPng(svg, (matrix.size+8)*10, style.transparent ? '#ffffff' : undefined)
    return await verifyPng(blob, expected, style, matrix, printMm)
  } catch { return { kind:'failed', message:'Could not verify in this browser', reason:'Could not rasterize this SVG for verification.' } }
}
