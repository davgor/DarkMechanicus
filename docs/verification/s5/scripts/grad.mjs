// true-colour gradient: 80 background cells red -> brass -> teal, then the same as foreground blocks
const stops = [[0xea,0x41,0x34],[0xd6,0x9b,0x4a],[0x4c,0xc7,0xa8]]
const at = (t) => { const s = t < .5 ? 0 : 1, u = (t - s * .5) * 2; return stops[s].map((v, i) => Math.round(v + (stops[s + 1][i] - v) * u)) }
let a = '', b = ''
for (let i = 0; i < 80; i++) { const [r, g, bl] = at(i / 79); a += `\x1b[48;2;${r};${g};${bl}m `; b += `\x1b[38;2;${r};${g};${bl}m█` }
console.log(a + '\x1b[0m'); console.log(b + '\x1b[0m')
