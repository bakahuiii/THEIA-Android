import * as cheerio from 'cheerio'
import { AuthRequiredError } from '../auth-required-error.mjs'
import { compactError } from '../util.mjs'
import { parseTheolAssignments, parseTheolCourse, parseTheolHome, parseTheolMobileTaskList } from '../parsers/theol-basic.mjs'

const BASE = 'https://course.buct.edu.cn/meol/'
const PERSONAL = new URL('personal.do', BASE).toString()
const WELCOME = new URL('welcomepage/student/index.jsp', BASE).toString()
// This is THEOL's SSO hand-off. Opening personal.do directly can return a
// guest/error page instead of redirecting through the already authenticated CAS.
const SSO_LOGIN = new URL('homepage/common/sso_login.jsp', BASE).toString()
// THEOL still exposes this legacy mobile endpoint over HTTP. The HTTPS path
// currently returns 404, even when the authenticated personal page is HTTPS.
const MOBILE_TASKS = 'http://course.buct.edu.cn/mobile/stuUnDoTaskList.do'
const THEOL_HOME_TIMEOUT_MS = 20_000
const THEOL_TASK_TIMEOUT_MS = 7_000
const THEOL_COURSE_TIMEOUT_MS = 7_000
const THEOL_COURSE_SCAN_LIMIT = 18
const THEOL_TASK_LINK_LIMIT = 4
const THEOL_COURSE_SCAN_CONCURRENCY = 4
const THEOL_ASSIGNMENT_SCAN_TIMEOUT_MS = 28_000

async function requestBeforeDeadline(request, deadline, controller, onTimeout) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    onTimeout?.()
    controller.abort()
    throw Object.assign(new Error('课程页补读作业与测试超过时间限制'), { name: 'TimeoutError' })
  }
  let timer
  try {
    return await Promise.race([
      request(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.()
          controller.abort()
          reject(Object.assign(new Error('课程页补读作业与测试超过时间限制'), { name: 'TimeoutError' }))
        }, remaining)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function outcome(value, capturedAt, errorCode = null) {
  return {
    attempted: true,
    succeeded: !errorCode,
    status: errorCode ? 'failed' : 'succeeded',
    capturedAt,
    emptyConfirmed: !errorCode && Array.isArray(value) && value.length === 0,
    completeness: errorCode ? 'unknown' : 'complete',
    errorCode,
  }
}

function taskListLinks(links) {
  const unique = (items) => [...new Map(items.map((item) => [item.url, item])).values()]
  const direct = unique((Array.isArray(links) ? links : []).filter((item) => /(?:hwtask|stu_qtest_navigate|question_test_student_list)/i.test(item.url)))
  if (direct.length) return direct.slice(0, THEOL_TASK_LINK_LIMIT)
  return unique((Array.isArray(links) ? links : [])
    .filter((item) => /(?:课程作业|在线测试|作业|测试|hwtask|test|quiz|exam)/i.test(`${item.title} ${item.url}`))
  ).slice(0, THEOL_TASK_LINK_LIMIT)
}

function coursePageMatches(courseResult, course) {
  const expected = String(course?.id || '').trim()
  if (!expected) return false
  const identities = new Set()
  const addUrlIdentities = (rawUrl, baseUrl) => {
    if (!rawUrl) return
    try {
      const url = new URL(rawUrl, baseUrl)
      for (const [name, value] of url.searchParams.entries()) {
        if (['courseid', 'lid', 'cateid'].includes(name.toLowerCase()) && value.trim()) identities.add(value.trim())
      }
    } catch { /* a malformed DOM URL is not identity evidence */ }
  }
  let finalUrl
  try {
    finalUrl = new URL(courseResult?.url || '')
    addUrlIdentities(finalUrl.toString(), finalUrl)
  } catch { return false }
  const html = String(courseResult?.text || '')
  const $ = cheerio.load(html)
  $('[name], [href], [action], [src]').each((_index, node) => {
    const element = $(node)
    const name = String(element.attr('name') || '').toLowerCase()
    const value = String(element.attr('value') || '').trim()
    if (['courseid', 'lid', 'cateid'].includes(name) && value) identities.add(value)
    for (const attribute of ['href', 'action', 'src']) addUrlIdentities(element.attr(attribute), finalUrl)
  })
  $('script, [onclick]').each((_index, node) => {
    const source = `${$(node).html() || ''} ${$(node).attr('onclick') || ''}`
    for (const match of source.matchAll(/["']?(?:courseId|lid|cateId)["']?\s*[:=]\s*["']?(\d+)/giu)) {
      identities.add(match[1])
    }
  })
  // Some THEOL versions redirect personal.do to a shell without a course
  // query parameter. Once CampusPageClient has ruled out the login page, the
  // absence of contradictory identity evidence is the only reliable signal.
  return identities.size === 0 || [...identities].every((identity) => identity === expected)
}

async function scanCourseAssignments(client, courses, capturedAt) {
  const assignments = []
  const errors = []
  const listedCourses = (Array.isArray(courses) ? courses : [])
    .filter((course) => course?.sourceUrl && course?.id)
    .slice(0, THEOL_COURSE_SCAN_LIMIT)
  const deadline = Date.now() + THEOL_ASSIGNMENT_SCAN_TIMEOUT_MS
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), THEOL_ASSIGNMENT_SCAN_TIMEOUT_MS)
  let timeoutReported = false
  const reportTimeout = () => {
    if (!timeoutReported) {
      timeoutReported = true
      errors.push('课程页补读作业与测试超过时间限制')
    }
  }
  let nextIndex = 0
  const scanOne = async () => {
    while (nextIndex < listedCourses.length) {
      if (Date.now() >= deadline) {
        reportTimeout()
        controller.abort()
        return
      }
      const listedCourse = listedCourses[nextIndex]
      nextIndex += 1
      try {
        const courseResult = await requestBeforeDeadline(
          () => client.page(listedCourse.sourceUrl, {
            source: `课程平台 ${listedCourse.title}`,
            timeoutMs: THEOL_COURSE_TIMEOUT_MS,
            signal: controller.signal,
          }),
          deadline,
          controller,
          reportTimeout,
        )
        if (!coursePageMatches(courseResult, listedCourse)) throw new Error('课程平台返回了其他课程页面')
        const course = parseTheolCourse(courseResult.text, {
          course: listedCourse,
          sourceUrl: courseResult.url,
          capturedAt,
        })
        const links = taskListLinks(course.assignmentLinks)
        await Promise.all(links.map(async (link) => {
          if (Date.now() >= deadline) {
            reportTimeout()
            controller.abort()
            return
          }
          try {
            const taskResult = await requestBeforeDeadline(
              () => client.page(link.url, {
                source: `课程平台 ${listedCourse.title} 作业与测试`,
                timeoutMs: THEOL_TASK_TIMEOUT_MS,
                signal: controller.signal,
              }),
              deadline,
              controller,
              reportTimeout,
            )
            assignments.push(...parseTheolAssignments(taskResult.text, {
              course,
              sourceUrl: taskResult.url,
              capturedAt,
            }))
          } catch (error) {
            if (controller.signal.aborted) {
              reportTimeout()
              return
            }
            errors.push(`${listedCourse.title}: ${compactError(error)}`)
          }
        }))
      } catch (error) {
        if (controller.signal.aborted) {
          reportTimeout()
          return
        }
        errors.push(`${listedCourse.title}: ${compactError(error)}`)
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(THEOL_COURSE_SCAN_CONCURRENCY, listedCourses.length) }, () => scanOne()))
  } finally {
    clearTimeout(timeout)
  }
  return {
    assignments: [...new Map(assignments.map((item) => [item.id, item])).values()].slice(0, 500),
    errors,
    scannedCourses: listedCourses.length,
  }
}

export class TheolBasicAdapter {
  constructor(client, { onProgress = () => {} } = {}) {
    this.client = client
    this.onProgress = onProgress
  }

  async status() {
    try {
      const result = await this.client.page(PERSONAL, { source: '课程平台', timeoutMs: THEOL_HOME_TIMEOUT_MS })
      const parsed = parseTheolHome(result.text, result.url)
      return { connected: parsed.loggedIn, checkedAt: new Date().toISOString(), url: result.url }
    } catch (error) {
      return { connected: false, checkedAt: new Date().toISOString(), authRequired: error instanceof AuthRequiredError, error: compactError(error) }
    }
  }

  async sync({ domains = ['courses', 'assignments', 'notices'] } = {}) {
    const requested = new Set(domains)
    if (![...requested].every((domain) => ['courses', 'assignments', 'notices'].includes(domain))) throw new TypeError('THEOL 只支持课程、作业和通知读取')
    const capturedAt = new Date().toISOString()
    this.onProgress({ status: 'syncing', label: '正在读取课程平台…' })
    let homeResult = await this.client.page(PERSONAL, { source: '课程平台', timeoutMs: THEOL_HOME_TIMEOUT_MS })
    let home = parseTheolHome(homeResult.text, homeResult.url)
    if (!home.loggedIn) throw new AuthRequiredError('课程平台', homeResult.url)
    // Some THEOL releases keep the authenticated roster on the welcome page
    // while personal.do contains only the shell. Read that page as an
    // enrichment pass so assignments still have course IDs to scan.
    if (!home.courses.length) {
      try {
        const welcomeResult = await this.client.page(WELCOME, { source: '课程平台课程列表', timeoutMs: THEOL_HOME_TIMEOUT_MS })
        const welcome = parseTheolHome(welcomeResult.text, welcomeResult.url)
        if (welcome.loggedIn && (welcome.courses.length || welcome.notices.length)) {
          homeResult = welcomeResult
          home = {
            loggedIn: true,
            courses: welcome.courses.length ? welcome.courses : home.courses,
            notices: [...home.notices, ...welcome.notices],
          }
        }
      } catch {
        // The personal page remains a valid source for notices/courses when
        // this optional roster page is unavailable.
      }
    }
    const result = { capturedAt, source: { connected: true, checkedAt: capturedAt, url: homeResult.url }, errors: [], domainOutcomes: {} }
    if (requested.has('courses')) {
      result.courses = home.courses
      result.domainOutcomes.courses = outcome(home.courses, capturedAt)
    }
    if (requested.has('notices')) {
      result.notices = home.notices
      result.domainOutcomes.notices = outcome(home.notices, capturedAt)
    }
    if (requested.has('assignments')) {
      let mobileError = null
      try {
        this.onProgress({ status: 'syncing', label: '正在读取课程平台作业与测试…' })
        const payload = await this.client.json(MOBILE_TASKS, { source: '课程平台作业与测试', timeoutMs: THEOL_TASK_TIMEOUT_MS })
        const parsed = parseTheolMobileTaskList(payload, { courses: home.courses, capturedAt })
        if (!parsed.authenticated) throw new AuthRequiredError('课程平台', MOBILE_TASKS)
        if (!parsed.assignments.length && home.courses.length) throw new Error('课程平台移动作业接口未返回任务，转用课程页读取')
        result.assignments = parsed.assignments
        result.domainOutcomes.assignments = outcome(parsed.assignments, capturedAt)
      } catch (error) {
        mobileError = error
      }
      if (mobileError) {
        this.onProgress({ status: 'syncing', label: '正在通过课程页面补读作业与测试…' })
        const fallback = await scanCourseAssignments(this.client, home.courses, capturedAt)
        result.assignments = fallback.assignments
        const authRequired = [compactError(mobileError), ...fallback.errors]
          .some((message) => /课程平台.*(?:会话已失效|认证|登录)|会话已失效/u.test(String(message)))
        if (authRequired) result.authRequired = true
        if (fallback.assignments.length || !fallback.errors.length) {
          // The mobile feed is unavailable on some sessions, but course pages
          // still provide a useful read-only task list. Surface this as a
          // partial result instead of making the UI retry forever.
          result.domainOutcomes.assignments = {
            ...outcome(fallback.assignments, capturedAt),
            completeness: 'partial',
            errorCode: authRequired ? 'theol_auth_required' : 'mobile_task_feed_unavailable',
          }
          result.errors.push(`课程平台作业接口不可用，已使用课程页补读：${compactError(mobileError)}`)
          if (fallback.errors.length) result.errors.push(...fallback.errors.slice(0, 4))
        } else {
          result.errors.push(compactError(mobileError), ...fallback.errors.slice(0, 4))
          result.domainOutcomes.assignments = outcome([], capturedAt, authRequired ? 'theol_auth_required' : 'assignment_read_failed')
        }
      }
    }
    this.onProgress({ status: 'done', label: '课程平台读取完成' })
    return result
  }
}

export const THEOL_URLS = Object.freeze({ login: SSO_LOGIN, home: PERSONAL })
