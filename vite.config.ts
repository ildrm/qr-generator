import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export default defineConfig({ plugins: [react(), {
  name: 'offline-asset-manifest',
  apply: 'build',
  async closeBundle() {
    const assets = await readdir(join('dist', 'assets'))
    await writeFile(join('dist', 'precache-manifest.json'), JSON.stringify(assets.map(asset => `./assets/${asset}`)))
    const workerPath = join('dist', 'sw.js')
    const worker = await readFile(workerPath, 'utf8')
    const index = await readFile(join('dist', 'index.html'))
    const revision = createHash('sha256').update(index).update(assets.join('\n')).update(worker).digest('hex').slice(0, 12)
    await writeFile(workerPath, worker.replace('__QR_BUILD_CACHE__', revision))
  },
}], base: './', optimizeDeps: { exclude: ['@nuintun/qrcode'] }, test: { environment: 'jsdom' } })
