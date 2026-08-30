// Android 9 devices can ship an older WebView than the desktop build target.
// Keep the small set of language APIs used by bundled campus parsers available
// before any other application module is evaluated.
const objectHasOwnName = ['has', 'Own'].join('')
const objectHasOwn = Object[objectHasOwnName]
if (typeof objectHasOwn !== 'function') {
  Object.defineProperty(Object, objectHasOwnName, {
    configurable: true,
    writable: true,
    value: (value, property) => {
      const target = Object(value)
      return typeof Object.getOwnPropertyDescriptor === 'function'
        ? Object.getOwnPropertyDescriptor(target, property) !== undefined
        : Object.getOwnPropertyNames(target).indexOf(String(property)) !== -1
    },
  })
}

if (typeof Object.fromEntries !== 'function') {
  Object.defineProperty(Object, 'fromEntries', {
    configurable: true,
    writable: true,
    value: (entries) => (entries || []).reduce((result, entry) => {
      if (entry && entry.length >= 2) result[entry[0]] = entry[1]
      return result
    }, {}),
  })
}

if (typeof String.prototype.replaceAll !== 'function') {
  Object.defineProperty(String.prototype, 'replaceAll', {
    configurable: true,
    writable: true,
    value: function replaceAll(search, replacement) {
      if (search instanceof RegExp) {
        if (!search.global) throw new TypeError('replaceAll requires a global RegExp')
        return this.replace(search, replacement)
      }
      return this.split(String(search)).join(String(replacement))
    },
  })
}

if (typeof String.prototype.padEnd !== 'function') {
  Object.defineProperty(String.prototype, 'padEnd', {
    configurable: true,
    writable: true,
    value: function padEnd(length, fill = ' ') {
      const target = Math.max(0, Number(length) || 0)
      if (this.length >= target) return String(this)
      const filler = String(fill || ' ')
      if (!filler) return String(this)
      const needed = target - this.length
      return String(this) + filler.repeat(Math.ceil(needed / filler.length)).slice(0, needed)
    },
  })
}

if (typeof Array.prototype.at !== 'function') {
  Object.defineProperty(Array.prototype, 'at', {
    configurable: true,
    writable: true,
    value: function at(index) {
      const position = Number(index) || 0
      const offset = position < 0 ? this.length + position : position
      return this[offset]
    },
  })
}
