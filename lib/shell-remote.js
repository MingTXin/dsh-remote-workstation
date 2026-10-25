/**
 * Remote executor for the POSIX shell service (`bash`).
 *
 * Mounted in place of `@deepseek-ai/dsh-bash-sandbox`; commands whose workdir is
 * inside a mount anchor run on the SSH host, everything else stays local.
 *
 * @module dsh-remote-workstation/shell-remote
 */

import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { createRemoteShellExecutor } from './shell-remote-core.js'

/** @type {typeof SandboxBashExecutor} */
export const RemoteBashExecutor = createRemoteShellExecutor(SandboxBashExecutor)

export default RemoteBashExecutor
