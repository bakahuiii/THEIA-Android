import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { AcademicApiClient } from '../core/academic-api-client.mjs'
import { CampusPageClient } from '../core/campus-page-client.mjs'
import { hasOwn, parseAcademicTerm, parseDateLike } from '../core/util.mjs'
import { parseJwGrades, parseJwQueryForm } from '../core/parsers/jwglxt.mjs'
import { buildBasicData } from '../core/basic-data.mjs'
import { parseTheolCourse, parseTheolHome, parseTheolMobileTaskList } from '../core/parsers/theol-basic.mjs'
import { TheolBasicAdapter } from '../core/adapters/theol-basic.mjs'
import { parseJwglxtExtraJson, parseJwglxtExtraPage } from '../core/jwglxt-extra.mjs'
import { JwglxtAdapter, mergeJwglxtGradeDetailRecords } from '../core/adapters/jwglxt.mjs'
import { splitSetCookieHeader } from '../core/util.mjs'
import { scheduleDetailKey } from '../core/schedule-utils.mjs'
import { nativeResponseBodyBytes, nativeResponseBytes, nativeResponseHeaders } from '../src/mobile/native-fetch.mjs'
import { isAcademicAuthFailure, syncWithRecovery } from '../core/auth-recovery.mjs'

test('academic authentication failures trigger one CAS recovery retry', async () => {
  let syncCalls = 0
  let recoveryCalls = 0
  const result = await syncWithRecovery({
    mode: 'cas',
    sync: async () => {
      syncCalls += 1
      if (syncCalls === 1) {
        const error = new Error('Academic system 需要重新完成统一身份认证')
        error.name = 'AuthRequiredError'
        throw error
      }
      return { ok: true }
    },
    recover: async () => {
      recoveryCalls += 1
      return true
    },
  })
  assert.deepEqual(result, { ok: true })
  assert.equal(syncCalls, 2)
  assert.equal(recoveryCalls, 1)
  assert.equal(isAcademicAuthFailure(Object.assign(new Error('会话已失效'), { code: 1006 })), true)
})

test('non-CAS failures and failed recovery are not retried repeatedly', async () => {
  let syncCalls = 0
  await assert.rejects(syncWithRecovery({
    mode: 'api',
    sync: async () => {
      syncCalls += 1
      throw Object.assign(new Error('Academic system 会话已失效'), { code: 1006 })
    },
    recover: async () => true,
  }))
  assert.equal(syncCalls, 1)

  syncCalls = 0
  await assert.rejects(syncWithRecovery({
    mode: 'cas',
    sync: async () => {
      syncCalls += 1
      throw new Error('Academic system 需要重新完成统一身份认证')
    },
    recover: async () => false,
  }))
  assert.equal(syncCalls, 1)
})

test('THEOL recognizes courseId and lid course links', () => {
  const parsed = parseTheolHome(
    '<ul><li><a href="/meol/course.do?lid=123">高等数学</a></li><li><a onclick="window.open(\'course.do?courseId=456\')">大学英语</a></li></ul><span>退出</span>',
    'https://course.buct.edu.cn/meol/personal.do',
  )
  assert.deepEqual(parsed.courses.map((course) => course.id), ['123', '456'])
  assert.equal(parsed.loggedIn, true)
})

test('THEOL recognizes legacy assignment and test links case-insensitively', () => {
  const parsed = parseTheolCourse(
    '<a href="/meol/common/hw/student/hwtask.view.jsp?hwtID=7">作业列表</a><a href="/meol/common/question/test/student/stu_qtest_navigate.jsp?TESTID=8">在线测试</a>',
    { course: { id: '123', title: '高等数学' }, sourceUrl: 'https://course.buct.edu.cn/meol/course.do?lid=123' },
  )
  assert.deepEqual(parsed.assignmentLinks.map((link) => link.url), [
    'https://course.buct.edu.cn/meol/common/hw/student/hwtask.view.jsp?hwtID=7',
    'https://course.buct.edu.cn/meol/common/question/test/student/stu_qtest_navigate.jsp?TESTID=8',
  ])
})

test('THEOL task parser handles nested data and code zero success responses', () => {
  const parsed = parseTheolMobileTaskList({
    code: 0,
    data: { list: [{ courseId: '123', taskList: [{ taskId: 7, name: '作业一', deadline: '2026-09-01' }] }] },
  }, { courses: [{ id: '123', title: '高等数学' }] })
  assert.equal(parsed.authenticated, true)
  assert.equal(parsed.assignments.length, 1)
  assert.equal(parsed.assignments[0].title, '作业一')
})

test('date parser handles compact campus dates, epoch values, and Chinese dates', () => {
  for (const value of ['202608291930', '1756476600000', '2026年8月29日 19时30分', '2026-08-29 19:30']) {
    assert.match(parseDateLike(value), /^202[5-6]-/u)
  }
})

test('legacy ownership helper works without a callable prototype method', () => {
  const inherited = Object.create({ inherited: true })
  inherited.own = true
  assert.equal(hasOwn(inherited, 'own'), true)
  assert.equal(hasOwn(inherited, 'inherited'), false)
  assert.equal(hasOwn(Object.create(null), 'missing'), false)

  const compatSource = fs.readFileSync(new URL('../src/mobile/compat.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(compatSource, /Object\.prototype\.hasOwnProperty\.call/u)
})

test('native CAS bridge covers the portal redirect cookie scope', () => {
  const pluginSource = fs.readFileSync(new URL('../android/app/src/main/java/io/github/bakahuiii/theia/basic/CasAuthPlugin.java', import.meta.url), 'utf8')
  assert.match(pluginSource, /PORTAL_COOKIE_URL\s*=\s*"https:\/\/portal\.buct\.edu\.cn\//u)
  assert.match(pluginSource, /seedCookies\(PORTAL_COOKIE_URL, seedCookieHeader/u)
  assert.match(pluginSource, /"https:\/\/portal\.buct\.edu\.cn\/normal\/login-mobile\.html"/u)
})

test('native CAS recovery waits through the portal and accepts alternate academic landing paths', () => {
  const pluginSource = fs.readFileSync(new URL('../android/app/src/main/java/io/github/bakahuiii/theia/basic/CasAuthPlugin.java', import.meta.url), 'utf8')
  assert.doesNotMatch(pluginSource, /automaticCasOnly\s*&&\s*isLoginUrl\(url\)[\s\S]{0,180}rejectAndClose/u)
  assert.doesNotMatch(pluginSource, /automaticTheolOnly\s*&&\s*isLoginUrl\(url\)[\s\S]{0,180}rejectAndClose/u)
  assert.match(pluginSource, /path\.contains\("login_slogin"\)/u)
  assert.match(pluginSource, /path\.startsWith\("\/jwglxt\/"\)/u)
  assert.match(pluginSource, /hasCookie\(jwglxtCookies,\s*"JSESSIONID"\)/u)
})

test('automatic THEOL recovery seeds each existing session into its own host scope', () => {
  const pluginSource = fs.readFileSync(new URL('../android/app/src/main/java/io/github/bakahuiii/theia/basic/CasAuthPlugin.java', import.meta.url), 'utf8')
  assert.match(pluginSource, /String seedTheolCookieHeader = call\.getString\("theolCookieHeader"/u)
  assert.match(pluginSource, /seedCookies\(CAS_COOKIE_URL, seedCookieHeader[\s\S]{0,260}seedCookies\(PORTAL_COOKIE_URL, seedCookieHeader[\s\S]{0,260}seedCookies\(JWGLXT_COOKIE_URL, seedAcademicCookieHeader[\s\S]{0,260}seedCookies\(THEOL_COOKIE_URL, seedTheolCookieHeader/u)
})

test('native CAS plugin releases pending login work when the Activity is destroyed', () => {
  const pluginSource = fs.readFileSync(new URL('../android/app/src/main/java/io/github/bakahuiii/theia/basic/CasAuthPlugin.java', import.meta.url), 'utf8')
  assert.match(pluginSource, /protected void handleOnDestroy\(\)/u)
  assert.match(pluginSource, /handler\.removeCallbacksAndMessages\(null\)/u)
  assert.match(pluginSource, /getBridge\(\)\.releaseCall\(pendingCall\)/u)
  assert.match(pluginSource, /destroyWebView\(\)/u)
})

test('native logout clears auth origins without wiping app WebStorage', () => {
  const pluginSource = fs.readFileSync(new URL('../android/app/src/main/java/io/github/bakahuiii/theia/basic/CasAuthPlugin.java', import.meta.url), 'utf8')
  assert.match(pluginSource, /AUTH_STORAGE_ORIGINS/u)
  assert.match(pluginSource, /deleteOrigin\(origin\)/u)
  assert.doesNotMatch(pluginSource, /deleteAllData\(\)/u)
})

test('CAS sync refreshes the native cookie manager before using an in-memory jar', () => {
  const appSource = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
  assert.match(appSource, /nativeApp\(\)\s*&&\s*campus\?\.mode\s*===\s*'cas'\)\s*await refreshNativeSessionCookies\(campus\)/u)
})

test('grade parser retains common publication date aliases', () => {
  const grades = parseJwGrades({ rows: [
    { kch: 'MATH1001A', kcmc: '数学', cj: '90', cjrq: '202608291930' },
    { kch: 'ENGL1001A', kcmc: '英语', cj: '88', publishedDate: '2026-08-28' },
  ] }, { term: { year: 2026, term: '3' } })
  assert.deepEqual(grades.map((grade) => Boolean(grade.publishedAt)), [true, true])
})

test('grade parser prefers release time over score entry time', () => {
  const [grade] = parseJwGrades({ rows: [{
    kch: 'MATH1001A',
    kcmc: '数学',
    cj: '90',
    cjsj: '202608291930',
    fbsj: '202609011015',
  }] }, { term: { year: 2026, term: '3' } })
  assert.equal(grade.publishedAt, parseDateLike('202609011015'))
  assert.equal(grade.releaseAt, parseDateLike('202609011015'))
})

test('query form keeps option labels for academic-plan identity matching', () => {
  const parsed = parseJwQueryForm(`
    <form action="/plan">
      <select name="njdm_id"><option value="2024" selected>2024 级</option></select>
      <select name="zymc"><option value="software" selected>软件工程</option></select>
    </form>
  `, 'https://jwglxt.buct.edu.cn/jwglxt/')
  assert.equal(parsed.labels.njdm_id, '2024 级')
  assert.equal(parsed.labels.zymc, '软件工程')
})

test('academic term codes use one canonical display and id', () => {
  assert.deepEqual(parseAcademicTerm('2025', '3', '2025-2026 1'), {
    id: '2025-3',
    year: 2025,
    term: '3',
    label: '2025-2026-第一学期',
  })
  assert.equal(parseAcademicTerm('2025', '9', '2025-2026 2').id, '2025-12')
})

test('failed or partial empty syncs retain previous campus records', () => {
  const previous = {
    terms: [{ id: '2025-3', year: 2025, term: '3', label: '2025-2026-第一学期' }],
    schedule: [{ id: 'old-schedule', title: '旧课表' }],
    grades: [{ id: 'old-grade', courseName: '旧成绩' }],
  }
  const next = buildBasicData({
    terms: [],
    schedule: [],
    grades: [],
    domainOutcomes: {
      terms: { status: 'failed', succeeded: false },
      schedule: { status: 'succeeded', succeeded: true, completeness: 'partial', emptyConfirmed: false },
      grades: { status: 'succeeded', succeeded: true, completeness: 'complete', emptyConfirmed: true },
    },
  }, 'student', previous)
  assert.equal(next.terms.some((term) => term.id === '2025-3'), true)
  assert.equal(next.schedule[0].id, 'old-schedule')
  assert.equal(next.grades.length, 0)
})

test('academic plan preview parser keeps viewer candidates same-origin', () => {
  const parsed = parseJwglxtExtraPage(
    '<a href="/jwglxt/jxzxjhgl/previewPlan?planId=123">查看培养计划</a><a href="https://example.com/file.pdf">外部文件</a>',
    { domain: 'academic-plan', routeCode: 'N153540', sourceUrl: 'https://jwglxt.buct.edu.cn/jwglxt/jxzxjhgl/preview.html' },
  )
  assert.equal(parsed.attachments.length, 1)
  assert.equal(parsed.attachments[0].sourceUrl, 'https://jwglxt.buct.edu.cn/jwglxt/jxzxjhgl/previewPlan?planId=123')
})

test('THEOL course fallback accepts a redirected page with an embedded course identity', async () => {
  const homeHtml = '<span>退出</span><a href="/meol/personal.do?lid=123">高等数学</a>'
  const courseHtml = '<input type="hidden" name="lid" value="123"><a href="/meol/common/hw/student/hwtask.view.jsp?hwtID=7">作业一</a>'
  const taskHtml = '<table><tr><td><a href="/meol/common/hw/student/hwtask.view.jsp?hwtID=7">作业一</a></td><td>2026-09-01</td><td>未提交</td></tr></table>'
  const client = {
    async page(url) {
      if (url.includes('personal.do') && !url.includes('lid=123')) return { url, text: homeHtml }
      if (url.includes('hwtask.view.jsp')) return { url, text: taskHtml }
      return { url: 'https://course.buct.edu.cn/meol/personal.do', text: courseHtml }
    },
    async json() {
      throw new Error('移动接口不可用')
    },
  }
  const result = await new TheolBasicAdapter(client).sync({ domains: ['courses', 'assignments'] })
  assert.equal(result.assignments.length, 1)
  assert.equal(result.assignments[0].title, '作业一')
})

test('THEOL assignment fallback exposes an expired session instead of a retry loop', async () => {
  const client = {
    async page(url) {
      if (url.includes('personal.do') && !url.includes('lid=123')) return {
        url,
        text: '<span>退出</span><a href="/meol/personal.do?lid=123">高等数学</a>',
      }
      throw new Error('课程平台会话已失效')
    },
    async json() {
      throw new Error('移动接口不可用')
    },
  }
  const result = await new TheolBasicAdapter(client).sync({ domains: ['assignments'] })
  assert.equal(result.authRequired, true)
  assert.equal(result.domainOutcomes.assignments.errorCode, 'theol_auth_required')
})

test('academic plan parser retains plan ids and data attribute PDF candidates', () => {
  const parsed = parseJwglxtExtraPage(
    '<table><tr><th>专业</th><th>执行计划信息表ID</th></tr><tr><td>软件工程</td><td>plan-2026</td></tr></table><div data-pdf-url="/jwglxt/jxzxjhgl/downloadPlan.pdf?id=plan-2026"></div>',
    { domain: 'academic-plan', routeCode: 'N153540', sourceUrl: 'https://jwglxt.buct.edu.cn/jwglxt/jxzxjhgl/index.html', includeCandidateRecords: true },
  )
  assert.equal(parsed.candidateRecords[0].planId, 'plan-2026')
  assert.equal(parsed.attachments[0].type, 'pdf')
})

test('academic plan binary preview is cached as a PDF attachment', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n')
  let saved = null
  const client = {
    setDiagnostic() {},
    async binary(url) {
      return {
        url,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        buffer: pdf,
      }
    },
  }
  const attachmentStore = {
    async find() { return null },
    async save(record) {
      saved = record
      return { cached: true, bytes: pdf.length, filename: 'plan.pdf', buffer: pdf }
    },
    async keepOnly() {},
  }
  const value = await new JwglxtAdapter(client, { attachmentStore }).fetchExtraPayload({
    domain: 'academic-plan',
    routeCode: 'N153540',
    method: 'get',
    url: 'https://jwglxt.buct.edu.cn/jwglxt/jxzxjhgl/previewPlan?planId=plan-1',
    source: 'Academic plan',
    capturedAt: '2026-08-29T00:00:00.000Z',
  })
  assert.equal(saved.extension, 'pdf')
  assert.deepEqual([...saved.buffer], [...pdf])
  assert.equal(value.completeness, 'complete')
  assert.equal(value.attachments.length, 1)
  assert.equal(value.attachments[0].type, 'pdf')
  assert.equal(value.attachments[0].cached, true)
})

test('academic plan preview follows nested HTML viewers to the PDF', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n')
  const html = (value) => new TextEncoder().encode(value)
  const calls = []
  const client = {
    setDiagnostic() {},
    async binary(url) {
      calls.push(url)
      if (url.endsWith('/preview.html')) {
        return { url, headers: new Headers({ 'content-type': 'text/html' }), buffer: html('<iframe src="/viewer/plan.html"></iframe>'), text: '<iframe src="/viewer/plan.html"></iframe>' }
      }
      if (url.endsWith('/viewer/plan.html')) {
        return { url, headers: new Headers({ 'content-type': 'text/html' }), buffer: html('<embed src="/download/plan"></embed>'), text: '<embed src="/download/plan"></embed>' }
      }
      return { url, headers: new Headers({ 'content-type': 'application/pdf' }), buffer: pdf }
    },
  }
  const attachmentStore = {
    async find() { return null },
    async save(record) { return { cached: true, bytes: record.buffer.length, filename: 'plan.pdf', buffer: record.buffer } },
    async keepOnly() {},
  }
  const value = await new JwglxtAdapter(client, { attachmentStore }).fetchExtraPayload({
    domain: 'academic-plan',
    routeCode: 'N153540',
    method: 'get',
    url: 'https://jwglxt.buct.edu.cn/jwglxt/preview.html',
    source: 'Academic plan',
    capturedAt: '2026-08-29T00:00:00.000Z',
  })
  assert.deepEqual(calls, [
    'https://jwglxt.buct.edu.cn/jwglxt/preview.html',
    'https://jwglxt.buct.edu.cn/viewer/plan.html',
    'https://jwglxt.buct.edu.cn/download/plan',
  ])
  assert.equal(value.attachments[0].type, 'pdf')
  assert.equal(value.attachments[0].cached, true)
})

test('grade detail JSON aliases preserve component and course identities', () => {
  const parsed = parseJwglxtExtraJson({ rows: [{ kch_id: 'KC-1', kcmc: '高等数学', fzcj: '95', xmblmc: '平时成绩' }] }, {
    domain: 'grade-details',
    routeCode: 'N305007',
    sourceUrl: 'https://jwglxt.buct.edu.cn/jwglxt/cjcx/cjcx_cxXsKccjList.html',
  })
  assert.equal(parsed.records[0].courseInternalId, 'KC-1')
  assert.equal(parsed.records[0].componentScore, 95)
  assert.equal(parsed.records[0].assessmentItem, '平时成绩')
})

test('grade detail components inherit the matching course summary', () => {
  const merged = mergeJwglxtGradeDetailRecords([
    {
      recordType: 'grade-course',
      courseCode: 'CS101',
      courseName: '程序设计',
      classInternalId: 'CLASS-1',
      courseInternalId: 'COURSE-1',
      academicYear: '2025',
      term: '3',
      overallScore: '92',
      credits: '3',
    },
    {
      recordType: 'grade-component',
      courseCode: 'CS101',
      classInternalId: 'CLASS-1',
      academicYear: '2025',
      term: '3',
      assessmentItem: '平时成绩',
      componentScore: '95',
    },
  ])
  assert.equal(merged[1].courseName, '程序设计')
  assert.equal(merged[1].courseInternalId, 'COURSE-1')
  assert.equal(merged[1].overallScore, '92')
})

test('campus page client propagates caller cancellation', async () => {
  const client = new CampusPageClient({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      const rejectAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (init.signal.aborted) {
        rejectAbort()
        return
      }
      init.signal.addEventListener('abort', rejectAbort, { once: true })
    }),
  })
  const controller = new AbortController()
  const request = client.page('https://course.buct.edu.cn/meol/personal.do', { signal: controller.signal })
  controller.abort()
  await assert.rejects(request, (error) => error?.name === 'AbortError' && error?.message === '请求已取消')
})

test('cookie parser keeps multiple native Set-Cookie values and Expires commas', () => {
  assert.deepEqual(splitSetCookieHeader('A=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/, B=2; Path=/'), [
    'A=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/',
    'B=2; Path=/',
  ])
})

test('campus cookie jars keep only cookie pairs and honor deletion attributes', () => {
  for (const Client of [AcademicApiClient, CampusPageClient]) {
    const client = new Client({ cookieHeader: 'JSESSIONID=old; XSRF=token; Path=/' })
    assert.equal(client.cookieHeader(), 'JSESSIONID=old; XSRF=token')
    client.absorbCookies(new Headers({ 'set-cookie': 'JSESSIONID=next; Path=/' }))
    assert.match(client.cookieHeader(), /JSESSIONID=next/u)
    client.setCookieHeader('JSESSIONID=')
    assert.doesNotMatch(client.cookieHeader(), /JSESSIONID=/u)
    client.setCookieHeader('JSESSIONID=next')
    client.absorbCookies(new Headers({ 'set-cookie': 'JSESSIONID=; Max-Age=0; Path=/' }))
    assert.doesNotMatch(client.cookieHeader(), /JSESSIONID=/u)
    client.absorbCookies(new Headers({ 'set-cookie': 'XSRF=expired; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/' }))
    assert.doesNotMatch(client.cookieHeader(), /XSRF=/u)
  }
})

test('native response bytes decode PDF base64 and preserve native JSON objects', () => {
  const pdf = nativeResponseBytes('JVBERi0xLjQ=')
  assert.equal(new TextDecoder().decode(pdf), '%PDF-1.4')
  const json = nativeResponseBodyBytes({
    status: 200,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    data: { data: 'success' },
  })
  assert.deepEqual(JSON.parse(new TextDecoder().decode(json)), { data: 'success' })
})

test('native successful HTML arraybuffer responses are decoded from base64', () => {
  const html = '<html><body>统一身份认证</body></html>'
  const encoded = Buffer.from(html).toString('base64')
  const bytes = nativeResponseBodyBytes({
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
    data: encoded,
  })
  assert.equal(new TextDecoder().decode(bytes), html)
})

test('native response bytes preserve short plain text instead of guessing base64', () => {
  assert.equal(new TextDecoder().decode(nativeResponseBytes('OK')), 'OK')
})

test('native response headers cannot break Fetch Response with non-ByteString metadata', () => {
  const headers = nativeResponseHeaders({
    'content-type': 'application/json; charset=UTF-8',
    'content-disposition': 'attachment; filename="培养计划.pdf"',
    'set-cookie': ['JSESSIONID=abc', 'XSRF=def'],
  })
  assert.doesNotThrow(() => new Response(new Uint8Array([123, 125]), { headers }))
  assert.equal(headers.get('content-type'), 'application/json; charset=UTF-8')
  assert.match(headers.get('content-disposition'), /attachment/u)
})

test('schedule cells keep Chinese course text readable on narrow screens', () => {
  const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
  assert.match(styles, /body\s*\{[^}]*min-width:\s*0[^}]*overflow-x:\s*hidden/u)
  assert.doesNotMatch(styles, /body\s*\{[^}]*min-width:\s*320px/u)
  assert.match(styles, /\.schedule-scroll\s*\{[^}]*overflow-x:\s*hidden/u)
  assert.match(styles, /\.schedule-board\s*\{[^}]*grid-template-rows:\s*52px repeat\([^}]*var\(--schedule-period-height\)\)[^}]*width:\s*100%[^}]*min-width:\s*0/u)
  assert.match(styles, /\.schedule-slot\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/u)
  assert.match(app, /class="schedule-slot\$\{crowdedClass\}" style="--schedule-slot-item-count:\$\{slot\.items\.length\}/u)
  assert.match(app, /const firstItem = slot\.items\[0\]/u)
  assert.match(app, /const firstCardTarget = extraCount/u)
  assert.match(app, /const firstCardLabel = extraCount/u)
  assert.match(app, /data-schedule-group="\$\{escapeHtml\(groupKey\)\}"/u)
  assert.match(app, /function scheduleGroupDialog\(items\)/u)
  assert.match(styles, /\.schedule-slot-course\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*visible/u)
  assert.match(styles, /\.schedule-slot-course\s*\{[^}]*align-self:\s*stretch/u)
  assert.doesNotMatch(styles, /\.schedule-slot-course\s*\{[^}]*flex:\s*1\s+1\s+0/u)
  assert.match(styles, /\.schedule-slot-course strong, \.schedule-slot-course span\s*\{[^}]*white-space:\s*normal/u)
  assert.doesNotMatch(styles, /\.schedule-slot-course strong, \.schedule-slot-course span\s*\{[^}]*text-overflow:\s*ellipsis/u)
  assert.match(styles, /\.schedule-slot\.has-more::before/u)
  assert.match(styles, /\.schedule-slot-stack\s*\{/u)
  assert.match(styles, /\.schedule-group-card\s*\{/u)
  assert.match(styles, /\.schedule-group-detail-grid\s*\{/u)
  assert.match(app, /function scheduleDetailValues\(item\)/u)
  assert.match(app, /完整信息/u)
})

test('stacked schedule entries with shared ids open as separate course details', () => {
  const first = {
    id: 'shared-class-id',
    termId: '2026-2027-1',
    weekday: 1,
    period: '1-2',
    title: '高等数学',
    room: '教一-101',
    teacher: '张老师',
    weeks: '1-16',
    courseCode: 'MATH101',
  }
  const second = { ...first, title: '大学英语', room: '教一-202', teacher: '李老师', courseCode: 'ENGL101' }

  assert.notEqual(scheduleDetailKey(first), scheduleDetailKey(second))
  assert.equal(scheduleDetailKey(first), scheduleDetailKey({ ...first }))
  assert.notEqual(scheduleDetailKey({ ...first, __scheduleIndex: 0 }), scheduleDetailKey({ ...first, __scheduleIndex: 1 }))
})
