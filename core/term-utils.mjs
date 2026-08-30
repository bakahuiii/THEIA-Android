export const TERM_CODE_ALIASES = Object.freeze({
  '1': '3',
  '2': '12',
  '3': '3',
  '9': '12',
  '12': '12',
  '16': '16',
})

export const TERM_CODE_LABELS = Object.freeze({
  '3': '第一学期',
  '12': '第二学期',
  '16': '第三学期',
})

export function normalizeTermCode(value) {
  const code = String(value ?? '').trim()
  return TERM_CODE_ALIASES[code] || code
}

export function termLabelForCode(value) {
  const code = normalizeTermCode(value)
  return TERM_CODE_LABELS[code] || `第 ${code} 学期`
}

export function canonicalTermId(value) {
  const text = String(value ?? '').trim()
  const match = text.match(/^(20\d{2})\s*-\s*(\d{1,2})$/u)
  return match ? `${match[1]}-${normalizeTermCode(match[2])}` : text
}
