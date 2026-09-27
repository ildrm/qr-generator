# QRlab

A private, static QR code studio. Content, uploaded logos, CSV files, and generated images stay in the browser. The project builds to static files and needs no account, application server, QR API, tracker, or hosted redirect.

## Run

```bash
npm ci
npm run dev
npm test
npm run typecheck
npm run lint
npm run build
npm run preview
```

Deploy the contents of `dist/` to static hosting. `base: './'` allows subdirectory hosting. Configure the host to serve the headers in `public/_headers` (Cloudflare Pages syntax) or equivalent on your host. HTTPS is required for service workers and some clipboard features; localhost is also supported. `public/robots.txt` permits indexing the public editor. No user-created payload becomes a public page.

## Use

Choose a content type, fill in its form, confirm the exact encoded value in **Inspect**, choose a preset if desired, wait for the scan state, and download PNG, SVG, or PDF. The default uses square, dark modules and a four-module quiet zone. Advanced controls include error correction, output pixels (256–4096), print width, gradient, transparent background, logo, and a short label. PNG and SVG are based on the same module matrix. The PDF places the verified PNG at the selected physical width on A4 or a larger page when needed.

Use **Saved** to explicitly save a design locally. By default this saves style only. For URL and plain-text content, the editor offers a separate opt-in checkbox to include the value. Wi-Fi passwords, contacts, messages, and event details cannot be saved in design history. Design JSON export contains style only; imports are schema-validated. Individual saved designs and all local data can be deleted. The small brand kit stores two colors and an optional safe raster logo locally.

Use **Batch** to download a CSV template, upload a file (1 MB and 500 rows maximum), map its columns, review errors, and produce a ZIP of PNG files. URL and plain-text rows use literal content. For structured types, the content cell must contain a JSON object matching the individual form's fields, with CSV quoting around the JSON. Invalid rows block export; ZIP creation is cancellable. Each row is verified before being included. Output is capped at 32 MB of input images and 2 MB per image.

## Encoding and scan checks

- Website URLs accept HTTP/HTTPS. A bare host gets `https://`, with a visible warning and final destination. No URL is shortened or routed through QRlab.
- Wi-Fi uses the common `WIFI:` syntax, with escaped delimiters. Contact cards use vCard 3.0 and CRLF line endings. Calendar events use iCalendar `VEVENT` in UTC with UID and DTSTAMP. Reader and import behavior varies by scanner and operating system.
- QR Model 2 encoding supports versions 1–40 and error correction L/M/Q/H. The renderer keeps finder, timing, format, version, and alignment patterns square. It keeps four quiet modules on every side by default.
- An independent decoder runs in a worker on rasterized SVG and on exported PNG bytes. **Verified by decoder** means this software read the rendered value exactly. It is not a guarantee for every camera, display, material, or print process. Low contrast, a transparent background, and modules under 0.35 mm produce a print-review state; undecodable designs are blocked from export with a safer-style action.
- Before a large print run, print at actual size and test at least two real devices in the intended lighting. QR content is not a substitute for a visible URL or human-readable explanation.

## Browser and offline behavior

The editor uses canvas, SVG image decoding, workers, and `createImageBitmap`. It is intended for current Chrome, Edge, Firefox, and Safari; actual cross-browser and physical-device validation is still needed. Image clipboard copying requires browser support and permission. PNG download is the fallback. Local storage failures and image processing failures are surfaced in the UI. The production service worker caches the app shell, decoder worker, and export libraries during installation, so QR creation and exports can work offline after the first successful visit. The first visit needs a connection.

The public app includes no remote fonts, images, trackers, or runtime QR services. Direct production dependencies are MIT-licensed, and `npm audit --omit=dev` reported zero known vulnerabilities on 2026-09-27. The existing repository GPLv2 license remains in `LICENSE`.

## Architecture

- `src/lib/payload.ts` — pure validation and serializers for eight content types.
- `src/lib/qr.ts` — matrix encoding, SVG composition, raster export, and print geometry.
- `src/workers/verify.worker.ts` and `src/lib/verify.ts` — independent decode and scan states.
- `src/lib/storage.ts` — versioned, validated local design and brand kit storage.
- `src/lib/batch.ts` — bounded CSV parsing, mapping, and ZIP generation.
- `src/App.tsx`, `src/styles.css` — editor, responsive UI, export controls, and guidance.
- `public/sw.js`, `public/_headers` — offline cache and example static-host security headers.

The QR encoder is `qrcode-generator` (MIT); the independent decoder is `@nuintun/qrcode` (MIT); ZIP is `fflate` (MIT); PDF is lazy-loaded `pdf-lib` (MIT). The decoder is bundled in a worker. The PDF library is only fetched when someone chooses PDF.

## Product boundary

These are **static** codes: the destination is embedded in the symbol and cannot change after printing. Scan counts, editable destinations, expiration, and campaign analytics require a separate dynamic QR service with hosted redirect URLs, persistent storage, uptime monitoring, abuse controls, privacy policy, operations, and ongoing hosting costs. Those features are not part of QRlab.

## Current validation limits

The automated suite covers payloads, capacity and correction levels, matrix/quiet-zone geometry, independent matrix decoding, CSV and ZIP, storage schema, and hostile input handling. A Chrome browser pass covered live URL preview and decoder state, PNG/SVG/PDF downloads, desktop and iPhone-sized layouts, an offline reload with decoder verification and PDF export, and a Lighthouse mobile audit. Physical scans on two devices, mobile contact/calendar import checks, and broader browser compatibility testing were not available in this environment and are not claimed as passed. The interface is English; other translations have not been reviewed. The interface uses semantic order and bidirectional isolation for encoded text, but full RTL localization remains future work.
