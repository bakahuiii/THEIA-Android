export function parsePeriodRange(period, maximum = 16) {
  const values = String(period || '').match(/\d+/g)?.map(Number).filter((value) => Number.isFinite(value)) || []
  if (!values.length || values[0] < 1 || values[0] > maximum) return null
  return { start: values[0], end: Math.min(maximum, Math.max(values[0], values[1] || values[0])) }
}

export function scheduleDetailKey(item) {
  return JSON.stringify([
    Number.isInteger(item?.__scheduleIndex) ? item.__scheduleIndex : null,
    item?.id ?? '',
    item?.termId ?? '',
    item?.weekday ?? '',
    item?.period ?? '',
    item?.title ?? '',
    item?.room ?? '',
    item?.teacher ?? '',
    item?.weeks ?? '',
    item?.courseCode ?? '',
    item?.classInternalId ?? '',
  ])
}

export function occursInWeek(weeks, week) {
  if (!weeks || !Number.isInteger(week) || week < 1) return true
  const text = String(weeks).replace(/\s+/g, '').replace(/[～—–－]/g, '-')
  const matches = [...text.matchAll(/(\d+)(?:[-~至到](\d+))?/g)]
  if (!matches.length) return true
  return matches.some((match, index) => {
    const start = Number(match[1])
    const end = Number(match[2] || match[1])
    if (week < start || week > end) return false
    const nextStart = matches[index + 1]?.index ?? text.length
    const suffix = text.slice((match.index || 0) + match[0].length, nextStart)
    const odd = /单|奇/.test(suffix)
    const even = /双|偶/.test(suffix)
    return odd === even || (odd ? week % 2 === 1 : week % 2 === 0)
  })
}
