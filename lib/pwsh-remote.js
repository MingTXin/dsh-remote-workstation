/**
 * Remote executor for the Windows shell service (`pwsh`).
 *
 * Mounted in place of `@deepseek-ai/dsh-pwsh-sandbox` on Windows; commands whose
 * workdir is inside a mount anchor run on the SSH host in a POSIX shell, so the
 * command string is interpreted by the remote shell rather than PowerShell.
 *
 * @module dsh-remote-workstation/pwsh-remote
 */

import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import z from '@deepseek-ai/schemastery'
import { createRemoteShellExecutor } from './shell-remote-core.js'

/** @type {typeof SandboxPwshExecutor} */
export const RemotePwshExecutor = createRemoteShellExecutor(SandboxPwshExecutor, {
  /** Declared pwsh executable; the stock pwsh config requires this live reference. */
  pwshPath: z.string().volatile(),
})

export default RemotePwshExecutor
