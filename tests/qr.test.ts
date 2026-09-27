import { describe, expect, it } from 'vitest'
import { Decoder } from '@nuintun/qrcode'
import { encodeQr, isFunctionalCell, renderSvg, totalModules, moduleSizeMm, safeFilename } from '../src/lib/qr'
import { DEFAULT_STYLE } from '../src/lib/storage'

function pixels(value: string, level: 'L'|'M'|'Q'|'H') {
  const matrix=encodeQr(value,level), unit=10, side=totalModules(matrix)*unit
  const data=new Uint8ClampedArray(side*side*4)
  for(let y=0;y<side;y++)for(let x=0;x<side;x++){
    const mx=Math.floor(x/unit)-4,my=Math.floor(y/unit)-4
    const dark=mx>=0&&my>=0&&mx<matrix.size&&my<matrix.size&&matrix.dark[my][mx]
    const i=(y*side+x)*4;data[i]=data[i+1]=data[i+2]=dark?0:255;data[i+3]=255
  }
  return {matrix,decoded:new Decoder().decode(data,side,side)?.data}
}

describe('Model 2 encoding and renderer geometry',()=>{
  it.each(['L','M','Q','H'] as const)('independent decoder reads Unicode at level %s',level=>{
    const value='https://example.com/こんにちは/سلام?x=✓'
    const {matrix,decoded}=pixels(value,level)
    expect(matrix.size).toBeGreaterThanOrEqual(21)
    expect((matrix.size-17)%4).toBe(0)
    expect(decoded).toBe(value)
  })
  it('reports capacity overflow',()=>{
    expect(()=>encodeQr('x'.repeat(10000),'H')).toThrow(/capacity/)
  })
  it('keeps a four module quiet zone and protected finder, timing, and alignment cells',()=>{
    const matrix=encodeQr('A'.repeat(180),'H')
    expect(totalModules(matrix)).toBe(matrix.size+8)
    expect(isFunctionalCell(0,0,matrix.size)).toBe(true)
    expect(isFunctionalCell(6,12,matrix.size)).toBe(true)
    expect(isFunctionalCell(matrix.size-7,matrix.size-7,matrix.size)).toBe(true)
    const svg=renderSvg(matrix,{...DEFAULT_STYLE,moduleStyle:'dots',finderStyle:'square'},512)
    expect(svg).toContain(`viewBox="0 0 ${matrix.size+8} ${matrix.size+8}"`)
    expect(svg).toContain('<circle')
    expect(svg).toContain('<rect x="4" y="4" width="1" height="1"')
    expect(moduleSizeMm(matrix,25)).toBeLessThan(1)
  })
  it('escapes labels and unsafe filenames',()=>{
    const svg=renderSvg(encodeQr('hello'),{...DEFAULT_STYLE,frame:{label:'<script>alert(1)</script>'}})
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    expect(safeFilename('../bad:name')).not.toMatch(/[/:]/)
  })
})
