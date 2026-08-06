import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dirname, 'out')
mkdirSync(OUT, { recursive: true })

const FONTS = [
  'fonts/JetBrainsMono-400.ttf',
  'fonts/JetBrainsMono-500.ttf',
  'fonts/JetBrainsMono-700.ttf',
  'fonts/JetBrainsMono-800.ttf',
].map(f => join(import.meta.dirname, f))

// Brand tokens from actana.ai stylesheet
const brand = '#1786c2'
const brand1 = '#279ed6'
const brand2 = '#6abbe1'
const ink = '#12161c'
const dark = '#101723'
const darkText2 = '#aeb9c6'
const muted = '#9aa4b0'

// The Actana mark, from https://actana.ai/favicon/actana.svg — geometry verbatim,
// parameterised gradient ids so it can be inlined more than once per document.
const mark = (id) => `
<g clip-path="url(#clip_${id})">
<path fill-rule="evenodd" clip-rule="evenodd" d="M7.13184 19.4247C6.55231 20.5601 6.53226 20.4316 4.02637 20.4315C3.69812 20.264 3.42908 20.0272 3.22363 19.7499C4.69651 18.3734 6.49142 17.3366 8.48535 16.7714L7.13184 19.4247ZM14.8896 16.6122C16.9758 17.0915 18.8661 18.0809 20.4277 19.4384C20.2139 19.8509 19.876 20.2042 19.4307 20.4315C17.0345 20.4316 16.9047 20.5601 16.3252 19.4247L14.8896 16.6122ZM8.94727 5.44229C10.5068 2.62601 12.9502 2.62601 14.5098 5.44229C15.975 8.08826 19.9187 16.252 20.3906 17.2304C18.5105 15.9036 16.3027 15.0107 13.9121 14.6972L11.7285 10.4189L9.49902 14.786C7.00417 15.2174 4.72689 16.2833 2.83887 17.8114C2.88053 17.6469 2.9391 17.4837 3.01953 17.3261C3.03803 17.2877 7.39091 8.25284 8.94727 5.44229Z" fill="url(#grad_${id}_a)"/>
<path d="M9.51855 41.7598C10.3213 41.9167 11.1504 42.001 11.999 42.001C12.616 42.001 13.2226 41.9561 13.8164 41.8721V42.4072H18.04C16.1996 43.2468 14.154 43.7148 11.999 43.7148C9.84406 43.7148 7.79844 43.2468 5.95801 42.4072H9.51855V41.7598ZM0 24.5156C-0.554277 25.9517 -0.858381 27.5121 -0.858398 29.1436C-0.858398 30.7747 -0.554059 32.3347 0 33.7705V37.4111C-1.62167 35.062 -2.57227 32.214 -2.57227 29.1436C-2.57224 26.0728 -1.62195 23.2242 0 20.875V24.5156ZM24 20.8779C25.6207 23.2266 26.5703 26.0741 26.5703 29.1436C26.5703 32.2128 25.6204 35.0597 24 37.4082V33.7646C24.5526 32.3304 24.8564 30.7725 24.8564 29.1436C24.8564 27.5143 24.5529 25.9559 24 24.5215V20.8779ZM11.999 14.5723C12.3553 14.5723 12.7087 14.5852 13.0586 14.6104L13.8164 16.0947V16.4141C13.2227 16.33 12.616 16.2861 11.999 16.2861C11.1504 16.2861 10.3212 16.3695 9.51855 16.5264V16.3369L10.373 14.6621C10.9069 14.6028 11.4494 14.5723 11.999 14.5723Z" fill="url(#grad_${id}_b)"/>
</g>`

const markDefs = (id) => `
<linearGradient id="grad_${id}_a" x1="11.7282" y1="3.33003" x2="11.7282" y2="20.436" gradientUnits="userSpaceOnUse">
<stop stop-color="${brand1}"/><stop offset="1" stop-color="${brand2}"/>
</linearGradient>
<linearGradient id="grad_${id}_b" x1="11.999" y1="43.7148" x2="11.999" y2="14.5723" gradientUnits="userSpaceOnUse">
<stop stop-color="${brand1}"/><stop offset="1" stop-color="${brand2}"/>
</linearGradient>
<clipPath id="clip_${id}"><rect width="24" height="24" fill="white"/></clipPath>`

// JetBrains Mono is the product's primary UI font (Studio look, spec 12) —
// every rendered asset uses it so the brand type is consistent with the app.
const jbmono = `'JetBrains Mono', monospace`

// ---------------------------------------------------------------- wordmark
// viewBox 560x120; icon 96px at left, text vertically centred on icon.
const wordmark = ({ primary, secondary }) => `<svg width="600" height="120" viewBox="0 0 600 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<defs>${markDefs('wm')}</defs>
<g transform="translate(8,12) scale(4)">${mark('wm')}</g>
<text x="116" y="78" font-family="${jbmono}" font-size="54" font-weight="700" fill="${primary}" letter-spacing="-1.5">Actana <tspan fill="${secondary}">Control</tspan></text>
</svg>`

// ---------------------------------------------------------------- banner
// 1280x640 social-preview layout, dark studio background.
const banner = () => `<svg width="1280" height="640" viewBox="0 0 1280 640" fill="none" xmlns="http://www.w3.org/2000/svg">
<defs>
${markDefs('bn')}
<radialGradient id="glow" cx="0.5" cy="0.42" r="0.65">
<stop stop-color="${brand1}" stop-opacity="0.22"/>
<stop offset="0.6" stop-color="${brand1}" stop-opacity="0.07"/>
<stop offset="1" stop-color="${brand1}" stop-opacity="0"/>
</radialGradient>
<linearGradient id="rule" x1="0" y1="0" x2="1280" y2="0" gradientUnits="userSpaceOnUse">
<stop stop-color="${brand1}" stop-opacity="0"/>
<stop offset="0.5" stop-color="${brand1}"/>
<stop offset="1" stop-color="${brand2}" stop-opacity="0"/>
</linearGradient>
</defs>
<rect width="1280" height="640" fill="${dark}"/>
<rect width="1280" height="640" fill="url(#glow)"/>
<rect x="0" y="0" width="1280" height="4" fill="url(#rule)"/>
<g transform="translate(568,128) scale(6)">${mark('bn')}</g>
<text x="640" y="354" text-anchor="middle" font-family="${jbmono}" font-size="58" font-weight="700" fill="#ffffff" letter-spacing="-1.6">Actana <tspan fill="${brand2}">Control</tspan></text>
<text x="640" y="418" text-anchor="middle" font-family="${jbmono}" font-size="24" font-weight="400" fill="${darkText2}">One cockpit for your coding agent, on your machine.</text>
<text x="640" y="506" text-anchor="middle" font-family="${jbmono}" font-size="19" fill="${muted}">Claude Code&#160;&#160;·&#160;&#160;Codex&#160;&#160;·&#160;&#160;Cursor CLI&#160;&#160;·&#160;&#160;your own machines</text>
</svg>`

// ---------------------------------------------------------------- icon
const icon = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<defs>${markDefs('ic')}</defs>
${mark('ic')}
</svg>`

function render(name, svg, scale) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: scale },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'JetBrains Mono' },
  })
  const png = r.render().asPng()
  writeFileSync(join(OUT, name), png)
  console.log(name, (png.length / 1024).toFixed(0) + 'KB')
}

const light = wordmark({ primary: ink, secondary: brand })
const darkWm = wordmark({ primary: '#ffffff', secondary: brand2 })

writeFileSync(join(OUT, 'logo-light.svg'), light)
writeFileSync(join(OUT, 'logo-dark.svg'), darkWm)
writeFileSync(join(OUT, 'banner-social.svg'), banner())
writeFileSync(join(OUT, 'actana-icon.svg'), icon(24))

render('logo-light.png', light, 3)      // 1680w, displayed at 380-420
render('logo-dark.png', darkWm, 3)
render('banner-social.png', banner(), 2) // 2560x1280
render('icon-256.png', icon(24), 256 / 24)
