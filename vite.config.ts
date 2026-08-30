import { defineConfig, type ProxyOptions } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { transformSync } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

function legacySyntaxTransformPlugin() {
  return {
    name: 'theia-basic-legacy-syntax',
    apply: 'build' as const,
    generateBundle(_options: unknown, bundle: Record<string, { type: string; code?: string; fileName: string }>) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk' || typeof file.code !== 'string') continue
        try {
          // Android 9 WebView does not implement Object.hasOwn. Some bundled
          // dependencies reference it directly, so keep the fallback local to
          // the generated chunk instead of relying on a startup race.
          const transformed = transformSync(file.code, {
            target: ['chrome74'],
            format: 'esm',
            loader: 'js',
            minify: false,
          }).code
          // Android 9 lacks Object.hasOwn. A few bundled dependencies also
          // spell the older helper incorrectly or call the prototype method;
          // route every form through the descriptor-based helper.
          const legacyCode = transformed
            .replace(/\bObject\.prototype\.hasOwnProperty\.call\s*\(/g, '__theiaHasOwn(')
            .replace(/\bObject\.hasOwnProperty\.call\s*\(/g, '__theiaHasOwn(')
            .replace(/\bObject\.hasOwnProperty\b/g, '__theiaHasOwn')
            .replace(/\bObject\.hasOwn\b/g, '__theiaHasOwn')
          // Keep the injected declaration terminated. The main chunk begins
          // with an IIFE; without this semicolon ASI turns the declaration
          // into a call expression and the production APK opens blank.
          file.code = `const __theiaHasOwn = (value, property) => { const target = Object(value); return typeof Object.getOwnPropertyDescriptor === 'function' ? Object.getOwnPropertyDescriptor(target, property) !== undefined : Object.getOwnPropertyNames(target).indexOf(String(property)) !== -1 };\n${legacyCode}`
        } catch (error) {
          console.warn('[theia-basic] syntax transform failed for ' + file.fileName + ': ' + String(error))
        }
      }
    },
  }
}

const campusProxy: ProxyOptions = {
  target: 'https://jwglxt.buct.edu.cn',
  changeOrigin: true,
  secure: true,
  rewrite: (requestPath) => requestPath.replace(/^\/__theia-campus/, ''),
  cookieDomainRewrite: '',
  cookiePathRewrite: '/',
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.removeHeader('origin')
      proxyReq.setHeader('referer', 'https://jwglxt.buct.edu.cn/jwglxt/')
    })
    proxy.on('proxyRes', (proxyRes) => {
      const cookies = proxyRes.headers['set-cookie']
      if (Array.isArray(cookies)) {
        proxyRes.headers['set-cookie'] = cookies.map((cookie) => cookie
          .replace(/;\s*Secure\b/gi, '')
          .replace(/;\s*SameSite=None\b/gi, ''))
      }
    })
  },
}

const courseProxy: ProxyOptions = {
  target: 'https://course.buct.edu.cn',
  changeOrigin: true,
  secure: true,
  rewrite: (requestPath) => requestPath.replace(/^\/__theia-course/, ''),
  cookieDomainRewrite: '',
  cookiePathRewrite: '/',
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.removeHeader('origin')
      proxyReq.setHeader('referer', 'https://course.buct.edu.cn/meol/')
    })
    proxy.on('proxyRes', (proxyRes) => {
      const cookies = proxyRes.headers['set-cookie']
      if (Array.isArray(cookies)) {
        proxyRes.headers['set-cookie'] = cookies.map((cookie) => cookie
          .replace(/;\s*Secure\b/gi, '')
          .replace(/;\s*SameSite=None\b/gi, ''))
      }
    })
  },
}

const courseHttpProxy: ProxyOptions = {
  ...courseProxy,
  target: 'http://course.buct.edu.cn',
  secure: false,
  rewrite: (requestPath) => requestPath.replace(/^\/__theia-course-http/, ''),
}

const motionProxy: ProxyOptions = {
  target: 'https://motion.buct.edu.cn',
  changeOrigin: true,
  secure: true,
  rewrite: (requestPath) => requestPath.replace(/^\/__theia-motion/, ''),
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.removeHeader('origin')
      proxyReq.setHeader('referer', 'https://motion.buct.edu.cn/changguanyuyue1/')
    })
  },
}

const calendarProxy: ProxyOptions = {
  target: 'https://jiaowuchu.buct.edu.cn',
  changeOrigin: true,
  secure: true,
  rewrite: (requestPath) => requestPath.replace(/^\/__theia-calendar/, ''),
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.removeHeader('origin')
      proxyReq.setHeader('referer', 'https://jiaowuchu.buct.edu.cn/')
    })
  },
}

export default defineConfig({
  base: './',
  plugins: [
    nodePolyfills({
      include: ['stream', 'buffer', 'process', 'util', 'assert', 'querystring', 'url', 'events', 'zlib'],
      globals: { Buffer: true, global: true, process: true },
      overrides: {
        buffer: path.join(root, 'src/mobile/polyfills/node-buffer.mjs'),
        crypto: path.join(root, 'src/mobile/polyfills/node-crypto.mjs'),
        module: path.join(root, 'src/mobile/polyfills/node-module.mjs'),
        path: path.join(root, 'src/mobile/polyfills/node-path.mjs'),
      },
    }),
    legacySyntaxTransformPlugin(),
  ],
  resolve: {
    alias: {
      'iconv-lite': path.join(root, 'node_modules/iconv-lite/lib/index.js'),
      'cheerio': path.join(root, 'node_modules/cheerio/dist/browser/index.js'),
      'vite-plugin-node-polyfills/shims/buffer': path.join(root, 'node_modules/vite-plugin-node-polyfills/shims/buffer/dist/index.js'),
      'vite-plugin-node-polyfills/shims/global': path.join(root, 'node_modules/vite-plugin-node-polyfills/shims/global/dist/index.js'),
      'vite-plugin-node-polyfills/shims/process': path.join(root, 'node_modules/vite-plugin-node-polyfills/shims/process/dist/index.js'),
      'node:crypto': path.join(root, 'src/mobile/polyfills/node-crypto.mjs'),
      'node:buffer': path.join(root, 'src/mobile/polyfills/node-buffer.mjs'),
      'node:module': path.join(root, 'src/mobile/polyfills/node-module.mjs'),
      'node:path': path.join(root, 'src/mobile/polyfills/node-path.mjs'),
      'node:perf_hooks': path.join(root, 'src/mobile/polyfills/node-perf.mjs'),
      'node:fs/promises': path.join(root, 'src/mobile/polyfills/node-fs.mjs'),
      'node:fs': path.join(root, 'src/mobile/polyfills/node-fs.mjs'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    proxy: { '/__theia-campus': campusProxy, '/__theia-course-http': courseHttpProxy, '/__theia-course': courseProxy, '/__theia-motion': motionProxy, '/__theia-calendar': calendarProxy },
  },
  preview: {
    host: '127.0.0.1',
    proxy: { '/__theia-campus': campusProxy, '/__theia-course-http': courseHttpProxy, '/__theia-course': courseProxy, '/__theia-motion': motionProxy, '/__theia-calendar': calendarProxy },
  },
  build: {
    target: 'es2018',
    outDir: 'dist',
    chunkSizeWarningLimit: 4096,
  },
})
