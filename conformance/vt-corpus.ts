export type VtCase = { name: string; cols: number; rows: number; input: string }

const ESC = '\u001b'
const CSI = `${ESC}[`
const OSC = `${ESC}]`
const BEL = '\u0007'

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\r\n')
}

export const VT_CORPUS: VtCase[] = [
  { name: 'plain-and-scrollback', cols: 20, rows: 4, input: `${lines(9)}\r\n$ ` },
  {
    name: 'sgr-colours',
    cols: 40,
    rows: 6,
    input: [
      `${CSI}31mred${CSI}0m ${CSI}1;32mbold green${CSI}22m plain-green${CSI}39m`,
      `${CSI}38;5;208morange256${CSI}0m ${CSI}48;5;24mbg24${CSI}0m`,
      `${CSI}38;2;10;20;30mtruecolor${CSI}0m ${CSI}48;2;200;100;50mtruebg${CSI}0m`,
      `${CSI}2mdim${CSI}0m ${CSI}3mitalic${CSI}0m ${CSI}4munder${CSI}0m ${CSI}7minverse${CSI}0m ${CSI}9mstrike${CSI}0m ${CSI}8mhidden${CSI}0m`,
      `${CSI}91mbright${CSI}0m ${CSI}38:2::1:2:3mcolon${CSI}0m`,
    ].join('\r\n'),
  },
  {
    name: 'progress-bar',
    cols: 40,
    rows: 3,
    input: `${[0, 25, 50, 75, 100].map((p) => `\r${CSI}2K[${'#'.repeat(p / 4).padEnd(25)}] ${p}%`).join('')}\r\ndone`,
  },
  {
    name: 'cursor-moves-and-erase',
    cols: 12,
    rows: 5,
    input: `${lines(5, 'row')}${CSI}2;3H${ESC}7XY${CSI}5;1H${ESC}8Z${CSI}3;1H${CSI}K${CSI}4;4H${CSI}1K${CSI}1;8H${CSI}J`,
  },
  { name: 'erase-display-above', cols: 10, rows: 4, input: `${lines(4, 'ab')}${CSI}3;2H${CSI}1J` },
  {
    name: 'wide-combining-emoji',
    cols: 12,
    rows: 4,
    input: '漢字かな\r\né café\r\n🙂 ok 👍🏽\r\n界界界界界界界',
  },
  { name: 'autowrap', cols: 8, rows: 4, input: 'abcdefghijklmnopq\r\nend' },
  { name: 'autowrap-off', cols: 8, rows: 3, input: `${CSI}?7labcdefghijklmn${CSI}?7h\r\nok` },
  {
    name: 'scroll-region',
    cols: 10,
    rows: 6,
    input: `${lines(6, 'r')}${CSI}2;4r${CSI}4;1H\nA\nB${CSI}r${CSI}6;1Hend`,
  },
  {
    name: 'insert-delete',
    cols: 10,
    rows: 5,
    input: `${lines(5, 'L')}${CSI}2;1H${CSI}2L${CSI}5;1H${CSI}M${CSI}1;1H${CSI}2@>>${CSI}1;6H${CSI}2P${CSI}3;1H${CSI}3X`,
  },
  { name: 'tabs', cols: 30, rows: 3, input: `a\tb\tc\r\n${CSI}3g${ESC}[5G${ESC}H\rx\ty\r\n\tz` },
  {
    name: 'alt-screen',
    cols: 12,
    rows: 3,
    input: `primary\r\nshell${CSI}?1049hALT SCREEN${CSI}2;1Hsecond${CSI}?1049lback`,
  },
  { name: 'alt-screen-active', cols: 12, rows: 3, input: `before${CSI}?1049h${CSI}Hfull${CSI}?25l` },
  { name: 'title-and-bell', cols: 20, rows: 2, input: `${OSC}0;my title${BEL}hi${BEL}${OSC}2;second${ESC}\\` },
  { name: 'dec-graphics', cols: 12, rows: 3, input: `${ESC}(0lqqk\r\nx  x\r\nmqqj${ESC}(B ok` },
  { name: 'modes', cols: 10, rows: 2, input: `${CSI}?1h${CSI}?2004h${CSI}?1000h${CSI}?1006h${CSI}?1004hmodes` },
  { name: 'repeat-and-reverse-index', cols: 10, rows: 4, input: `x${CSI}5b${CSI}1;1H${ESC}Mtop\r\n${ESC}Dnext` },
  { name: 'reset', cols: 10, rows: 3, input: `${CSI}31mgone${ESC}cfresh` },
]
