const DB_NAME = 'theia-basic.attachments.v1'
const STORE_NAME = 'files'
const MAX_BYTES = 32 * 1024 * 1024

function storageKey(id, extension) {
  return `${String(id || '').trim()}.${String(extension || 'bin').replace(/^\./u, '').toLowerCase()}`
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new Uint8Array(value || [])
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('attachment_store_request_failed'))
  })
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('attachment_store_transaction_failed'))
    transaction.onabort = () => reject(transaction.error || new Error('attachment_store_transaction_aborted'))
  })
}

async function sha256(bytes) {
  if (!window.crypto?.subtle) return null
  const digest = await window.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function metadata(record) {
  if (!record?.bytes || record.bytes > MAX_BYTES) return null
  const bytes = bytesOf(record.buffer)
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') return null
  return {
    cached: true,
    bytes: record.bytes,
    sha256: record.sha256 || null,
    filename: record.filename || null,
    buffer: bytes,
  }
}

export function createAttachmentStore() {
  const memory = new Map()
  let databasePromise = null

  function database() {
    if (databasePromise) return databasePromise
    if (!window.indexedDB) return Promise.resolve(null)
    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('attachment_store_open_failed'))
    }).catch(() => null)
    return databasePromise
  }

  async function find(id, extension = 'pdf') {
    const key = storageKey(id, extension)
    const db = await database()
    if (!db) return metadata(memory.get(key))
    try {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const record = await requestResult(transaction.objectStore(STORE_NAME).get(key))
      return metadata(record)
    } catch {
      return null
    }
  }

  async function save({ id, extension = 'pdf', buffer, exclusive = false } = {}) {
    const bytes = bytesOf(buffer)
    if (!bytes.length) throw new Error('教务附件为空')
    if (bytes.length > MAX_BYTES) throw new Error('教务附件超过 32 MB 限制')
    if (String(extension).replace(/^\./u, '').toLowerCase() === 'pdf'
      && (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-')) {
      throw new Error('教务附件不是有效 PDF')
    }
    const normalizedExtension = String(extension || 'bin').replace(/^\./u, '').toLowerCase()
    const key = storageKey(id, normalizedExtension)
    const record = {
      key,
      id: String(id || '').trim(),
      extension: normalizedExtension,
      bytes: bytes.length,
      buffer: bytes.slice().buffer,
      sha256: await sha256(bytes),
      filename: `${String(id || 'attachment').trim()}.${normalizedExtension}`,
    }
    const db = await database()
    if (!db) memory.set(key, record)
    else {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(record)
      await transactionResult(transaction)
    }
    if (exclusive) await keepOnly({ id, extension: normalizedExtension })
    return metadata(record)
  }

  async function keepOnly({ id, extension = 'pdf' } = {}) {
    const normalizedExtension = String(extension || 'bin').replace(/^\./u, '').toLowerCase()
    const keep = storageKey(id, normalizedExtension)
    const db = await database()
    if (!db) {
      for (const [key, record] of memory) {
        if (record.extension === normalizedExtension && key !== keep) memory.delete(key)
      }
      return
    }
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const records = await requestResult(store.getAll())
      for (const record of records || []) {
        if (record.extension === normalizedExtension && record.key !== keep) store.delete(record.key)
      }
      await transactionResult(transaction)
    } catch {
      // A cache cleanup failure must not hide a successfully downloaded PDF.
    }
  }

  return { find, save, keepOnly }
}
