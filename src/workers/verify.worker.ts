import { Decoder } from '@nuintun/qrcode'

const decoder = new Decoder()

self.onmessage = (event: MessageEvent<{ id: number; data: Uint8ClampedArray; width: number; height: number; expected: string }>) => {
  const { id, data, width, height, expected } = event.data
  try {
    const result = decoder.decode(data, width, height)
    self.postMessage({ id, decoded: result?.data ?? null, match: result?.data === expected })
  } catch (error) { self.postMessage({ id, decoded: null, match: false, error: String(error) }) }
}
