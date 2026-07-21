// Üretim derlemesini tek dosyalık, kendi kendine yeten bir HTML'e paketler.
// Kullanım: npm run build && node scripts/pack.mjs [çıktı-yolu]
// Not: replace() çağrılarında replacer FONKSİYON kullanılır; düz string
// kullanılırsa bundle içindeki "$&", "$'" gibi diziler özel yorumlanıp
// script'i bozar.
import fs from 'node:fs'
import path from 'node:path'

const dist = path.resolve('dist')
let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
const assets = fs.readdirSync(path.join(dist, 'assets'))
const jsFile = assets.find((f) => f.endsWith('.js'))
const cssFile = assets.find((f) => f.endsWith('.css'))
if (!jsFile || !cssFile) throw new Error('dist/assets içinde js/css bulunamadı')

const js = fs.readFileSync(path.join(dist, 'assets', jsFile), 'utf8')
const css = fs.readFileSync(path.join(dist, 'assets', cssFile), 'utf8')

html = html.replace(/<script type="module"[^>]*><\/script>/, () => '')
html = html.replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${css}</style>`)
html = html.replace('</body>', () => `<script type="module">${js}</script></body>`)

const out = process.argv[2] ?? path.join(dist, 'football2d.html')
fs.writeFileSync(out, html)
console.log(`OK: ${out} (${html.length} bayt)`)
