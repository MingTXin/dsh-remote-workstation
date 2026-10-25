/**
 * Promisified SFTP operations with DSH filesystem error mapping.
 *
 * Every helper takes an already-open ssh2 SFTP session and a POSIX remote path.
 * Missing-file and permission failures map onto `FsError` codes so the policy
 * layer and tools branch on codes instead of message strings, exactly like the
 * local backend.
 *
 * @module dsh-remote-workstation/ssh/sftp
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/** ssh2 SFTP status codes we care about. */
const STATUS_NO_SUCH_FILE = 2
const STATUS_PERMISSION_DENIED = 3

/**
 * @param {unknown} error
 * @returns {number | undefined} the ssh2 status code when this is an SFTP status error
 */
function statusCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'number') return error.code
  return undefined
}

/**
 * Map an SFTP failure onto the DSH filesystem error vocabulary.
 * @param {unknown} error
 * @param {string} verb short operation name used in the message ("stat", "read", ...)
 * @param {string} displayPath
 * @param {AbortSignal | undefined} signal
 * @returns {FsError}
 */
export function mapSftpError(error, verb, displayPath, signal) {
  if (signal?.aborted) return new FsError(`${verb} aborted`, 'FS_ABORTED', { cause: error })
  const code = statusCode(error)
  if (code === STATUS_NO_SUCH_FILE) {
    return new FsError(`cannot ${verb} "${displayPath}": no such file or directory`, 'FS_NOT_FOUND', { cause: error })
  }
  if (code === STATUS_PERMISSION_DENIED) {
    return new FsError(`cannot ${verb} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new FsError(`cannot ${verb} "${displayPath}": ${detail}`, 'FS_IO_ERROR', { cause: error })
}

/**
 * Invoke a callback-style SFTP method.
 * @template T
 * @param {any} sftp
 * @param {string} method
 * @param {any[]} args
 * @returns {Promise<T>}
 */
function invoke(sftp, method, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    sftp[method](...args, (error, result) => {
      if (error) rejectPromise(error)
      else resolvePromise(result)
    })
  })
}

/**
 * @param {any} sftp
 * @param {string} remotePath
 * @returns {Promise<any | null>} attrs, or null when the path does not exist
 */
export async function stat(sftp, remotePath) {
  try {
    return await invoke(sftp, 'lstat', [remotePath])
  } catch (error) {
    if (statusCode(error) === STATUS_NO_SUCH_FILE) return null
    throw error
  }
}

/**
 * Follow the final path component, like `fs.stat` (used for target metadata).
 * @param {any} sftp
 * @param {string} remotePath
 * @returns {Promise<any | null>}
 */
export async function statFollow(sftp, remotePath) {
  let current = remotePath
  let info = await stat(sftp, current)
  for (let hops = 0; info && isSymlink(info) && hops < 32; hops += 1) {
    const target = await invoke(sftp, 'readlink', [current])
    current = target.startsWith('/')
      ? target
      : current.slice(0, current.lastIndexOf('/') + 1) + target
    info = await stat(sftp, current)
  }
  return info
}

/**
 * @param {any} attrs
 * @returns {boolean}
 */
export function isDirectory(attrs) {
  return attrs != null && (Number(attrs.mode) & 0o170000) === 0o040000
}

/**
 * @param {any} attrs
 * @returns {boolean}
 */
export function isFile(attrs) {
  return attrs != null && (Number(attrs.mode) & 0o170000) === 0o100000
}

/**
 * @param {any} attrs
 * @returns {boolean}
 */
export function isSymlink(attrs) {
  return attrs != null && (Number(attrs.mode) & 0o170000) === 0o120000
}

/**
 * Map SFTP attributes onto `FsInfo.type`.
 * @param {any} attrs
 * @returns {'file' | 'directory' | 'other'}
 */
export function entryType(attrs) {
  if (isDirectory(attrs)) return 'directory'
  if (isFile(attrs)) return 'file'
  return 'other'
}

/**
 * Directory entries, without `.`/`..`.
 * @param {any} sftp
 * @param {string} remotePath
 * @returns {Promise<Array<{ name: string, attrs: any }>>}
 */
export async function readdir(sftp, remotePath) {
  const entries = await invoke(sftp, 'readdir', [remotePath])
  return entries
    .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
    .map((entry) => ({ name: entry.filename, attrs: entry.attrs }))
}

/**
 * Read a whole file.
 * @param {any} sftp
 * @param {string} remotePath
 * @returns {Promise<Buffer>}
 */
export async function readFile(sftp, remotePath) {
  return invoke(sftp, 'readFile', [remotePath])
}

/**
 * Open a read stream. `start`/`end` are inclusive byte offsets; pass neither to
 * read the whole file.
 * @param {any} sftp
 * @param {string} remotePath
 * @param {{ start?: number, end?: number }} [range]
 */
export function createReadStream(sftp, remotePath, range = {}) {
  const stream = sftp.createReadStream(remotePath, { ...range, autoClose: true })
  // Async iteration propagates read failures at the `for await` site, but a
  // failure that arrives after the consumer stopped (abort, size cap) or after
  // `destroy()` would be an `error` event with no listener — an uncaught
  // exception that kills the DSH host. Keep one no-op listener for that tail.
  stream.on('error', () => {})
  return stream
}

/**
 * Write bytes to a path, creating or truncating it.
 * @param {any} sftp
 * @param {string} remotePath
 * @param {Uint8Array} bytes
 * @param {number | undefined} mode
 */
export async function writeFile(sftp, remotePath, bytes, mode) {
  await invoke(sftp, 'writeFile', mode === undefined ? [remotePath, bytes] : [remotePath, bytes, { mode }])
}

/**
 * Rename (or move) a path, replacing an existing destination file.
 * @param {any} sftp
 * @param {string} from
 * @param {string} to
 */
export async function rename(sftp, from, to) {
  await invoke(sftp, 'rename', [from, to])
}

/**
 * Remove a file.
 * @param {any} sftp
 * @param {string} remotePath
 */
export async function unlink(sftp, remotePath) {
  await invoke(sftp, 'unlink', [remotePath])
}

/**
 * Create a directory (one level).
 * @param {any} sftp
 * @param {string} remotePath
 */
export async function mkdir(sftp, remotePath) {
  await invoke(sftp, 'mkdir', [remotePath])
}

/**
 * Canonicalize a remote path.
 * @param {any} sftp
 * @param {string} remotePath
 * @returns {Promise<string>}
 */
export async function realpath(sftp, remotePath) {
  return invoke(sftp, 'realpath', [remotePath])
}
