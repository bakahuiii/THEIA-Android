import * as cheerio from 'cheerio'
import { absoluteUrl, hasOwn, normalizeText, parseDateLike, parseNumber, stableId } from '../util.mjs'

function linkText($, node) {
  return normalizeText($(node).text() || $(node).attr('title') || $(node).attr('aria-label'))
}

function inlineTarget($, node) {
  const element = $(node)
  const href = String(element.attr('href') || '').trim()
  if (href && !/^javascript:/iu.test(href)) return href
  const source = String(element.attr('onclick') || '')
  const patterns = [
    /(?:window\.open|location(?:\.href)?|(?:MM_)?goToURL|open)\s*\(\s*['"]([^'"]+)['"]/iu,
    /(?:href|url|src)\s*[:=]\s*['"]([^'"]+)['"]/iu,
  ]
  return patterns.map((pattern) => source.match(pattern)?.[1] || '').find(Boolean) || ''
}

function courseLink($, node, baseUrl) {
  const element = $(node)
  const href = inlineTarget($, node)
  const onclick = element.attr('onclick') || ''
  const rawUrl = href || onclick.match(/['"]([^'"]*(?:courseId|courseID|lid|cateid)\s*=\s*[^'"]*)['"]/iu)?.[1] || ''
  let resolved = absoluteUrl(rawUrl, baseUrl)
  let courseId = ''
  try {
    const url = resolved ? new URL(resolved) : null
    const parameter = [...(url?.searchParams?.entries?.() || [])]
      .find(([name, value]) => /^(?:courseid|lid|cateid)$/iu.test(name) && value.trim())
    courseId = parameter ? String(parameter[1] || '').trim() : ''
  } catch { /* fall through to legacy inline handlers */ }
  if (!courseId) {
    courseId = onclick.match(/(?:courseId|courseID|lid|cateid)\s*[=:]\s*['"]?([A-Za-z0-9_-]{1,160})/iu)?.[1] || ''
  }
  if (!courseId) {
    courseId = ['courseId', 'courseID', 'lid', 'cateid', 'data-course-id', 'data-lid']
      .map((name) => element.attr(name) || '')
      .find((value) => value.trim()) || ''
  }
  if (!courseId || !/^\d+$/u.test(courseId)) return null
  if (!resolved) {
    resolved = absoluteUrl(`personal.do?lid=${encodeURIComponent(courseId)}`, baseUrl)
  }
  return resolved ? { courseId, href: resolved } : null
}

export function parseTheolHome(html, baseUrl) {
  const $ = cheerio.load(html)
  const courses = []
  $('a[href], a[onclick]').each((_index, node) => {
    const link = courseLink($, node, baseUrl)
    if (!link) return
    const { courseId, href } = link
    const container = $(node).closest('li, tr, .course, .course-item, .course-list-item').first()
    const title = normalizeText(container.find('.title a[title]').first().attr('title') || container.find('.title').first().text() || linkText($, node))
    if (!courseId || !title || courses.some((item) => item.id === courseId)) return
    const parent = normalizeText(container.length ? container.text() : $(node).parent().text())
    courses.push({
      id: courseId,
      code: normalizeText(container.find('.coursenum').first().attr('title') || parent.match(/课程编号[:：]\s*([^\s|]+)/)?.[1]) || null,
      title,
      teacher: normalizeText(container.find('.realname span.realname').first().text() || parent.match(/(?:主讲)?教师[:：]\s*([^\s|]+)/)?.[1]) || null,
      source: 'theol',
      sourceUrl: href,
    })
  })
  const notices = []
  $('a').each((_index, node) => {
    const href = absoluteUrl($(node).attr('href'), baseUrl)
    const title = linkText($, node)
    const context = normalizeText($(node).parent().text())
    if (!href || !title || title.length < 3 || !/通知|公告|消息|提醒/.test(title + context)) return
    notices.push({ id: stableId('theol-notice', href, title), title, summary: context.slice(0, 300), publishedAt: parseDateLike(context), source: 'theol', sourceUrl: href })
  })
  const pageText = $.text()
  const hasUserSignal = /退出|个人中心|我的课程|登录时间[:：]|在线总时长|互动提醒/.test(pageText)
  const hasCredentialForm = $('input[type="password"], form[action*="loginCheck"]').length > 0 || /请输入密码|密码登录/.test(pageText)
  return { courses, notices: [...new Map(notices.map((item) => [item.id, item])).values()].slice(0, 100), loggedIn: hasUserSignal || (courses.length > 0 && !hasCredentialForm) }
}

export function parseTheolCourse(html, { course, sourceUrl, capturedAt = new Date().toISOString() } = {}) {
  const $ = cheerio.load(html)
  const links = []
  $('a[href], a[onclick]').each((_index, node) => {
    const href = absoluteUrl(inlineTarget($, node), sourceUrl)
    const title = linkText($, node)
    if (!href || !title || title.length < 2) return
    if (!links.some((item) => item.url === href && item.title === title)) links.push({ title, url: href })
  })
  const bodyText = normalizeText($.text())
  const courseInfo = {}
  const infoPatterns = [
    ['assignmentCount', /课程作业数[:：]\s*(\d+)/u],
    ['testCount', /(?:在线测试|测试)数[:：]\s*(\d+)/u],
  ]
  for (const [key, pattern] of infoPatterns) {
    const match = bodyText.match(pattern)
    if (match) courseInfo[key] = Number(match[1])
  }
  return {
    ...(course || {}),
    assignmentLinks: links.filter((item) => /作业|任务|测试|试卷|问卷|hwtask|exam|quiz/i.test(`${item.title} ${item.url}`)).slice(0, 100),
    courseInfo: Object.keys(courseInfo).length ? courseInfo : null,
    sourceUrl,
    capturedAt,
  }
}

function assignmentLink(rawHref, sourceUrl) {
  const href = absoluteUrl(rawHref, sourceUrl)
  if (!href) return null
  let url
  try { url = new URL(href) } catch { return null }
  const match = [
    { path: /\/hwtask\.view\.jsp$/i, parameter: 'hwtid', kind: 'assignment' },
    { path: /\/stu_qtest_navigate\.jsp$/i, parameter: 'testId', kind: 'online-test' },
  ].find((candidate) => candidate.path.test(url.pathname))
  if (!match) return null
  const identifiers = [...url.searchParams.entries()]
    .filter(([name]) => name.toLowerCase() === match.parameter.toLowerCase())
    .map(([_name, value]) => value.trim())
    .filter(Boolean)
  if (identifiers.length !== 1 || !/^\d+$/u.test(identifiers[0])) return null
  return { href, kind: match.kind, identifier: identifiers[0] }
}

function assignmentDueText($, node, kind, text) {
  const cells = $(node).children('td')
  const structured = kind === 'online-test' ? cells.eq(2).text() : cells.eq(1).text()
  const datePattern = /([0-9]{4}[年./-][0-9]{1,2}[月./-][0-9]{1,2}(?:日)?(?:\s+[0-9]{1,2}:?[0-9]{2}(?::[0-9]{2})?)?)/u
  return normalizeText(structured).match(datePattern)?.[1]
    || text.match(/(?:截止|结束|完成时间|提交时间)[:：]?\s*([0-9]{4}[年./-][0-9]{1,2}[月./-][0-9]{1,2}(?:日)?(?:\s+[0-9]{1,2}:?[0-9]{2}(?::[0-9]{2})?)?)/u)?.[1]
    || ''
}

export function parseTheolAssignments(html, { course, sourceUrl, capturedAt = new Date().toISOString() } = {}) {
  const $ = cheerio.load(html)
  const items = []
  $('tr, li, .task, .homework, .hw-item, .list-item').each((_index, node) => {
    const text = normalizeText($(node).text())
    if (!text) return
    let link = null
    let task = null
    $(node).find('a[href], a[onclick]').each((_linkIndex, candidate) => {
      if (task) return
      const parsed = assignmentLink(inlineTarget($, candidate), sourceUrl)
      if (!parsed) return
      link = candidate
      task = parsed
    })
    if (!task || !link) return
    const firstCell = $(node).children('td').first()
    const title = task.kind === 'assignment'
      ? linkText($, link)
      : normalizeText(firstCell.clone().find('a, button, img, input').remove().end().text()) || normalizeText(firstCell.text())
    if (!title) return
    const score = text.match(/(?:成绩|得分)[:：]?\s*([0-9]+(?:\.\d+)?)/u)?.[1] || null
    const status = /已提交|已完成|已交/u.test(text) ? 'submitted' : /未提交|未完成/u.test(text) ? 'pending' : 'unknown'
    items.push({
      kind: task.kind,
      id: stableId('theol-assignment', task.kind, task.identifier),
      courseId: course?.id || null,
      courseName: course?.title || null,
      title,
      dueAt: parseDateLike(assignmentDueText($, node, task.kind, text)),
      score: score ? parseNumber(score) : null,
      status,
      source: 'theol',
      sourceUrl: task.href,
      capturedAt,
    })
  })
  return [...new Map(items.map((item) => [item.id, item])).values()].slice(0, 200)
}

function statusCode(value) {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function taskGroups(course) {
  const groups = []
  const visit = (value, key = '', depth = 0) => {
    if (!value || depth > 5) return
    if (Array.isArray(value)) {
      if (/(?:reminder|assign|homework|test|quiz|task)/iu.test(key)) groups.push(...value)
      else value.forEach((item) => visit(item, key, depth + 1))
      return
    }
    if (typeof value !== 'object') return
    for (const [childKey, child] of Object.entries(value)) {
      if (!/(?:reminder|assign|homework|test|quiz|task)/iu.test(childKey)) {
        visit(child, childKey, depth + 1)
        continue
      }
      if (Array.isArray(child)) groups.push(...child)
      else if (child && typeof child === 'object') groups.push(...Object.values(child).flatMap((item) => Array.isArray(item) ? item : [item]))
    }
  }
  visit(course)
  return [...new Set(groups.filter((item) => item && typeof item === 'object'))]
}

function taskData(payload, depth = 0, seen = new Set()) {
  if (depth > 5 || !payload || typeof payload !== 'object' || seen.has(payload)) return null
  if (Array.isArray(payload)) return payload
  seen.add(payload)
  const keys = ['datas', 'data', 'rows', 'items', 'list', 'courseList', 'taskList', 'records']
  for (const key of keys) {
    if (!(key in payload)) continue
    const value = payload[key]
    if (Array.isArray(value)) return value
    const nested = taskData(value, depth + 1, seen)
    if (nested) return nested
  }
  return null
}

export function parseTheolMobileTaskList(payload, { courses = [], capturedAt = new Date().toISOString() } = {}) {
  const statusValue = payload?.status ?? payload?.code
  const status = statusCode(statusValue)
  if (status === -2) return { authenticated: false, assignments: [] }
  const data = taskData(payload)
  const statusOk = status === 1 || status === 0 || payload?.success === true || statusValue === true || /^(?:ok|success|succeeded)$/iu.test(String(statusValue || '')) || (status == null && Array.isArray(data))
  if (!statusOk || !Array.isArray(data)) throw new Error('THEOL 作业接口返回了无法识别的数据')
  const byCourse = new Map(courses.map((course) => [String(course?.id || ''), course]))
  const assignments = []
  for (const courseItem of data) {
    const courseId = String(courseItem?.courseId ?? courseItem?.courseID ?? courseItem?.lid ?? courseItem?.id ?? '').trim()
    if (!/^\d+$/.test(courseId)) continue
    const course = byCourse.get(courseId)
    for (const task of taskGroups(courseItem)) {
      if (!task || typeof task !== 'object' || task.publishStatus === false || task.publishStatus === 0 || task.publishStatus === 'false') continue
      const taskId = String(task.id ?? task.taskId ?? task.taskid ?? task.testId ?? task.testid ?? task.TESTID ?? task.hwtid ?? task.hwtId ?? task.hwtID ?? '').trim()
      const title = normalizeText(task.title ?? task.name ?? task.taskName ?? task.testName ?? task.taskname ?? task.subject ?? task.taskTitle ?? task.itemName)
      if (!/^\d+$/.test(taskId) || !title) continue
      const typeText = `${task.type || ''} ${task.taskType || ''} ${task.kind || ''}`
      const test = hasOwn(task, 'expiredTime') || hasOwn(task, 'examType') || /测试|考试|quiz|test/i.test(typeText)
      const kind = test ? 'online-test' : 'assignment'
      const path = test ? 'common/question/test/student/stu_qtest_navigate.jsp' : 'common/hw/student/hwtask.view.jsp'
      assignments.push({
        id: stableId('theol-assignment', kind, taskId),
        kind,
        courseId,
        courseName: normalizeText(courseItem?.courseName ?? courseItem?.courseTitle ?? courseItem?.name) || course?.title || null,
        title,
        dueAt: parseDateLike(test
          ? (task.expiredTime ?? task.expireTime ?? task.endTime ?? task.deadline)
          : (task.deadline ?? task.deadlineTime ?? task.dueTime ?? task.endTime)),
        score: null,
        status: /已提交|已完成|已交/u.test(String(task.status ?? task.state ?? task.completeStatus ?? '')) ? 'submitted' : 'pending',
        source: 'theol',
        sourceUrl: `https://course.buct.edu.cn/meol/${path}?${test ? 'testId' : 'hwtid'}=${encodeURIComponent(taskId)}`,
        capturedAt,
      })
    }
  }
  return { authenticated: true, assignments: [...new Map(assignments.map((item) => [item.id, item])).values()].slice(0, 500) }
}
