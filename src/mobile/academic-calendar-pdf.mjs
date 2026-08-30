let pdfjsPromise = null

function pdfjsModule() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.js').then((module) => {
      const candidates = [module, module?.default, module?.default?.default]
      const runtime = candidates.find((candidate) => typeof candidate?.getDocument === 'function')
      if (!runtime) throw new Error('PDF.js 运行时加载失败')
      return runtime
    })
  }
  return pdfjsPromise
}

function configurePdfjs(pdfjs) {
  const pageDocument = typeof window !== 'undefined' ? window.document : null
  const workerOptions = pdfjs?.GlobalWorkerOptions
  if (!pageDocument || !workerOptions) return false
  try {
    workerOptions.workerSrc = new URL('pdf.worker.min.js', pageDocument.baseURI).toString()
    return Boolean(workerOptions.workerSrc)
  } catch {
    return false
  }
}

function nativeWebView() {
  try { return Boolean(globalThis.Capacitor?.isNativePlatform?.()) } catch { return false }
}

function legacyAndroidWebView() {
  if (!nativeWebView()) return false
  const version = String(globalThis.navigator?.userAgent || '').match(/Android\s+(\d+)/iu)?.[1]
  return Number.isInteger(Number(version)) && Number(version) < 10
}

function pdfResourceOptions() {
  const pageDocument = typeof window !== 'undefined' ? window.document : null
  if (!pageDocument?.baseURI) return {}
  try {
    return {
      cMapUrl: new URL('cmaps/', pageDocument.baseURI).toString(),
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', pageDocument.baseURI).toString(),
    }
  } catch {
    return {}
  }
}

async function openPdfDocument(pdfjs, bytes) {
  const workerConfigured = configurePdfjs(pdfjs)
  const options = {
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    ...pdfResourceOptions(),
    // Android 9 WebView can expose Worker while still refusing to load a
    // local worker asset. Android 10+ uses the bundled Worker for smoother
    // rendering, while the legacy path remains available as a fallback.
    disableWorker: legacyAndroidWebView() || !workerConfigured,
  }
  try {
    return await pdfjs.getDocument(options).promise
  } catch (error) {
    if (options.disableWorker) throw error
    // Desktop/browser preview may have a valid worker URL but fail to create
    // the worker because of a restrictive WebView or file origin.
    return pdfjs.getDocument({ ...options, disableWorker: true }).promise
  }
}

function lineText(items) {
  const rows = []
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item?.str || '').trim()
    if (!text) continue
    const x = Number(item?.transform?.[4]) || 0
    const y = Number(item?.transform?.[5]) || 0
    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= 2.5)
    if (!row) {
      row = { x, y, items: [] }
      rows.push(row)
    }
    row.items.push({ x, text })
  }
  return rows
    .sort((left, right) => right.y - left.y)
    .map((row) => row.items.sort((left, right) => left.x - right.x).map((item) => item.text).join(' '))
    .filter(Boolean)
}

export async function extractAcademicCalendarPdfText(buffer) {
  const bytes = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer || [])
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('校历 PDF 内容无效')
  const pdfjs = await pdfjsModule()
  const pdfDocument = await openPdfDocument(pdfjs, bytes)
  const pages = []
  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(lineText(content.items))
      page.cleanup?.()
    }
  } finally {
    await pdfDocument.destroy?.()
  }
  return pages.flat().join('\n')
}

export async function renderAcademicCalendarPdf(buffer, container) {
  const bytes = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer || [])
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('PDF 内容无效')
  if (!container || typeof document === 'undefined') throw new Error('PDF 预览容器不可用')
  const pdfjs = await pdfjsModule()
  const pdfDocument = await openPdfDocument(pdfjs, bytes)
  while (container.firstChild) container.removeChild(container.firstChild)
  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      if (!container.isConnected) break
      const page = await pdfDocument.getPage(pageNumber)
      const baseViewport = page.getViewport({ scale: 1 })
      const availableWidth = Math.max(280, Math.min(container.clientWidth || 900, 980))
      const scale = Math.min(1.45, Math.max(0.55, availableWidth / baseViewport.width))
      const viewport = page.getViewport({ scale })
      const outputScale = Math.min(2, Number(globalThis.devicePixelRatio) || 1)
      const wrapper = document.createElement('div')
      wrapper.className = 'pdf-page'
      wrapper.dataset.pageNumber = String(pageNumber)
      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-page-canvas'
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      wrapper.append(canvas)
      container.append(wrapper)
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('PDF 画布初始化失败')
      await page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      }).promise
      page.cleanup?.()
    }
  } finally {
    await pdfDocument.destroy?.()
  }
  const renderedPages = container.querySelectorAll('.pdf-page').length
  if (!renderedPages) throw new Error('PDF 没有可显示的页面')
  return renderedPages
}

export async function probeAcademicCalendarPdfRuntime() {
  const pdfjs = await pdfjsModule()
  return typeof pdfjs?.getDocument === 'function'
}
