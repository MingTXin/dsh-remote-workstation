/**
 * Path helpers for the remote-workspace provider.
 *
 * Two coordinate systems meet here:
 *  - HOST paths (Windows or POSIX), the only thing `node:fs` in this process can open.
 *  - REMOTE paths (always POSIX), the only thing the SFTP connection can open.
 *
 * A target key encodes the remote coordinate: `rw://<hostRef>/<absRemotePath>`.
 * The alias may not contain `/`, so parsing is unambiguous.
 *
 * @module dsh-remote-workstation/paths
 */

import path from 'node:path'

const KEY_PREFIX = 'rw://'

/**
 * @param {string} hostRef ssh host reference (alias or user@host[:port])
 * @param {string} remotePath absolute POSIX path on the remote host
 * @returns {string} opaque target key
 */
export function encodeTargetKey(hostRef, remotePath) {
  return `${KEY_PREFIX}${hostRef}${normalizeRemote(remotePath)}`
}

/**
 * @param {string} targetKey
 * @returns {{ hostRef: string, remotePath: string } | null} parsed coordinates, or null for a host-local target
 */
export function decodeTargetKey(targetKey) {
  if (typeof targetKey !== 'string' || !targetKey.startsWith(KEY_PREFIX)) return null
  const rest = targetKey.slice(KEY_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  return { hostRef: rest.slice(0, slash), remotePath: rest.slice(slash) }
}

/**
 * True when a model-supplied path names the remote namespace (`/x/y`) rather
 * than a host path. Windows drive paths and UNC paths are host paths.
 * @param {string} value
 */
export function isRemoteAbsolute(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}

/**
 * Normalize a remote POSIX path: absolute, collapsed separators, no `..` escape.
 * @param {string} value
 * @returns {string}
 */
export function normalizeRemote(value) {
  if (typeof value !== 'string' || value.length === 0) return '/'
  const forward = value.replace(/\\/g, '/')
  const normalized = path.posix.normalize(forward.startsWith('/') ? forward : `/${forward}`)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

/**
 * Join a remote directory and a relative remainder.
 * @param {string} root
 * @param {string} rel
 */
export function joinRemote(root, rel) {
  if (!rel || rel === '.') return normalizeRemote(root)
  return normalizeRemote(path.posix.join(normalizeRemote(root), rel))
}

/**
 * Whether `child` is `parent` or below it, both remote POSIX paths.
 * @param {string} parent
 * @param {string} child
 */
export function remoteContains(parent, child) {
  const p = normalizeRemote(parent)
  const c = normalizeRemote(child)
  if (p === c) return true
  return c.startsWith(p === '/' ? '/' : `${p}/`)
}

/**
 * Relative remote path from `root` to `target` (posix semantics).
 * @param {string} root
 * @param {string} target
 * @returns {string} forward-slash relative path, or '' when equal
 */
export function remoteRelative(root, target) {
  return path.posix.relative(normalizeRemote(root), normalizeRemote(target))
}

/**
 * Expand a leading `~` (and `~/`) against the user's home directory.
 * @param {string} value
 * @param {string} home
 */
export function expandHome(value, home) {
  if (typeof value !== 'string') return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return value
}

/**
 * Whether `child` is `parent` or below it, both host paths (case-insensitive on win32).
 * @param {string} parent
 * @param {string} child
 */
export function hostContains(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  if (rel === '') return true
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false
  return true
}

/**
 * Relative remainder of `child` under `parent` (host semantics, forward slashes).
 * @param {string} parent
 * @param {string} child
 * @returns {string}
 */
export function hostRelative(parent, child) {
  return path.relative(path.resolve(parent), path.resolve(child)).split(path.sep).join('/')
}
