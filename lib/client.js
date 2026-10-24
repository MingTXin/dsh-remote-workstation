/**
 * Browser half of dsh-remote-workstation: the "Remote" sidebar panel.
 *
 * It browses a remote host over the host JSON API (`/api/remote-workspace/*`)
 * and, when a directory is chosen, creates an anchor directory plus a workspace
 * record so the ordinary Files tab serves the remote tree.
 *
 * Shipped in the client-bundle format DSH loads from `/plugins/<pkg>/client.js`
 * (`window.__ModuleLoader__.load`), so no build step is required.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-workstation',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    const PANEL_ID = 'remote-workspace'
    const API = '/api/remote-workspace'
    const PANEL_ORDER = 45

    /** POST a panel action and unwrap `{ok, value}` / `{ok, error}`. */
    async function call(action, body) {
      const response = await fetch(`${API}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!payload || payload.ok !== true) {
        const message = payload && payload.error ? payload.error.message : `remote-workspace ${action} failed (${response.status})`
        throw new Error(message)
      }
      return payload.value
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 10, padding: 16, height: '100%', boxSizing: 'border-box', overflow: 'hidden' },
      row: { display: 'flex', gap: 8, alignItems: 'center' },
      path: { flex: 1, fontFamily: 'monospace', fontSize: 12, padding: '4px 8px', border: '1px solid rgba(128,128,128,.35)', borderRadius: 6, background: 'transparent', color: 'inherit' },
      select: { fontSize: 12, padding: '4px 6px', borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit' },
      button: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'rgba(128,128,128,.12)', color: 'inherit', cursor: 'pointer' },
      primary: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(80,140,255,.5)', background: 'rgba(80,140,255,.18)', color: 'inherit', cursor: 'pointer' },
      list: { flex: 1, overflow: 'auto', border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, minHeight: 120 },
      item: { display: 'flex', gap: 8, alignItems: 'center', padding: '3px 10px', fontSize: 12, fontFamily: 'monospace', cursor: 'pointer', whiteSpace: 'nowrap' },
      muted: { fontSize: 11, opacity: 0.6 },
      error: { fontSize: 12, color: '#e5534b', whiteSpace: 'pre-wrap' },
      notice: { fontSize: 12, color: '#3fb950', whiteSpace: 'pre-wrap' },
      mounts: { borderTop: '1px solid rgba(128,128,128,.25)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflow: 'auto' },
      section: { borderTop: '1px solid rgba(128,128,128,.25)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflow: 'auto' },
      form: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border: '1px solid rgba(128,128,128,.25)', borderRadius: 8 },
      field: { display: 'flex', gap: 6, alignItems: 'center' },
      label: { fontSize: 11, width: 66, opacity: 0.75, flexShrink: 0 },
      input: { flex: 1, minWidth: 0, fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit' },
      badge: { fontSize: 10, padding: '0 6px', borderRadius: 999, border: '1px solid rgba(128,128,128,.35)', opacity: 0.75, flexShrink: 0 },
      card: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, width: 320, maxWidth: 'calc(100vw - 40px)', borderRadius: 10, border: '1px solid rgba(128,128,128,.35)', background: 'rgba(24,24,28,.98)', boxShadow: '0 12px 32px rgba(0,0,0,.45)', color: 'inherit' },
      title: { fontSize: 12, fontWeight: 600 },
      choice: { fontSize: 12, padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(128,128,128,.35)', background: 'rgba(128,128,128,.12)', color: 'inherit', cursor: 'pointer', textAlign: 'left' },
      remoteList: { maxHeight: 240, overflow: 'auto', border: '1px solid rgba(128,128,128,.25)', borderRadius: 8 },
      footer: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
    }

    function dirnameOf(remotePath) {
      if (!remotePath || remotePath === '/') return '/'
      const index = remotePath.replace(/\/+$/, '').lastIndexOf('/')
      return index <= 0 ? '/' : remotePath.slice(0, index)
    }

    function emptyHostForm() {
      return { alias: '', host: '', port: '22', user: 'root', authKind: 'password', password: '', keyPath: '', passphrase: '' }
    }

    function PanelIcon(props) {
      const size = props.size || 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'data-dsh-panel-entry': PANEL_ID },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 5, rx: 1 }),
        h('rect', { x: 1.5, y: 8.5, width: 13, height: 5, rx: 1 }),
        h('circle', { cx: 4, cy: 5, r: 0.6, fill: 'currentColor' }),
        h('circle', { cx: 4, cy: 11, r: 0.6, fill: 'currentColor' }),
      )
    }

    /** @param {any} ctx the client plugin context */
    function createPage(ctx) {
      return function RemoteExplorerPage() {
        const [hosts, setHosts] = useState([])
        const [host, setHost] = useState('')
        const [cwd, setCwd] = useState('')
        const [entries, setEntries] = useState([])
        const [mounts, setMounts] = useState([])
        const [error, setError] = useState('')
        const [notice, setNotice] = useState('')
        const [busy, setBusy] = useState(false)
        const [hostsOpen, setHostsOpen] = useState(false)
        const [form, setForm] = useState(emptyHostForm())
        const [editingAlias, setEditingAlias] = useState('')
        const [hostBusy, setHostBusy] = useState(false)
        const [hostNotice, setHostNotice] = useState('')

        const loadMounts = useCallback(async () => {
          const result = await call('mounts')
          setMounts(result)
          return result
        }, [])

        const loadHome = useCallback(async (nextHost) => {
          const result = await call('home', { host: nextHost })
          setCwd(result.path)
          return result.path
        }, [])

        const browse = useCallback(async (nextHost, target) => {
          if (!nextHost || !target) return
          setBusy(true)
          setError('')
          try {
            const result = await call('list', { host: nextHost, path: target })
            setCwd(result.path)
            setEntries(result.entries)
          } catch (cause) {
            setError(String(cause instanceof Error ? cause.message : cause))
          } finally {
            setBusy(false)
          }
        }, [])

        useEffect(() => {
          let cancelled = false
          ;(async () => {
            try {
              const [hostList, mountList] = await Promise.all([call('hosts'), call('mounts')])
              if (cancelled) return
              setHosts(hostList)
              setMounts(mountList)
              const first = hostList.length > 0 ? hostList[0].alias : ''
              if (first) {
                setHost(first)
                const home = await call('home', { host: first })
                if (!cancelled) {
                  setCwd(home.path)
                  const listed = await call('list', { host: first, path: home.path })
                  if (!cancelled) setEntries(listed.entries)
                }
              }
            } catch (cause) {
              if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause))
            }
          })()
          return () => {
            cancelled = true
          }
        }, [])

        const switchHost = useCallback(async (event) => {
          const nextHost = event.target.value
          setHost(nextHost)
          setError('')
          setNotice('')
          try {
            const home = await call('home', { host: nextHost })
            setCwd(home.path)
            const listed = await call('list', { host: nextHost, path: home.path })
            setEntries(listed.entries)
          } catch (cause) {
            setError(String(cause instanceof Error ? cause.message : cause))
            setEntries([])
          }
        }, [])

        const go = useCallback((target) => {
          if (!host) return
          browse(host, target)
        }, [host, browse])

        const addWorkspace = useCallback(async () => {
          if (!host || !cwd) return
          setBusy(true)
          setError('')
          setNotice('')
          try {
            const result = await call('mount', { host, path: cwd })
            await loadMounts()
            let workspaceNote
            // `workspaces.list.getSnapshot()` yields `{ items: WorkspaceView[], … }`
            // (see api/workspace-controller client model), not a bare array.
            const snapshot = ctx.workspaces.list.getSnapshot()
            const items = Array.isArray(snapshot) ? snapshot : (snapshot && Array.isArray(snapshot.items) ? snapshot.items : [])
            const existing = items.find((entry) => entry && entry.path === result.mount.anchor)
            try {
              if (existing) {
                workspaceNote = `已在工作区列表中（「${existing.title ?? existing.path}」），在左侧打开后从右侧 Files 标签浏览远程目录。`
              } else {
                const workspace = await ctx.workspaces.create({ path: result.mount.anchor })
                workspaceNote = `已在工作区列表中加入「${workspace.title ?? workspace.path}」，可在左侧打开并从右侧 Files 标签浏览远程目录。`
              }
            } catch (cause) {
              workspaceNote = `锚点已就绪（${result.mount.anchor}），但自动创建工作区失败：${cause instanceof Error ? cause.message : String(cause)}。可在「添加工作区」中手动选择该目录。`
            }
            setNotice(workspaceNote)
          } catch (cause) {
            setError(String(cause instanceof Error ? cause.message : cause))
          } finally {
            setBusy(false)
          }
        }, [host, cwd, loadMounts])

        const unmount = useCallback(async (id) => {
          setBusy(true)
          setError('')
          try {
            await call('unmount', { id })
            await loadMounts()
          } catch (cause) {
            setError(String(cause instanceof Error ? cause.message : cause))
          } finally {
            setBusy(false)
          }
        }, [loadMounts])

        const editHost = useCallback((entry) => {
          setForm({ alias: entry.alias, host: entry.host, port: String(entry.port), user: entry.user, authKind: 'password', password: '', keyPath: '', passphrase: '' })
          setEditingAlias(entry.alias)
          setHostsOpen(true)
          setHostNotice(`正在编辑「${entry.alias}」：认证信息需要重新填写`)
        }, [])

        const saveHost = useCallback(async () => {
          setHostBusy(true)
          setError('')
          setHostNotice('')
          try {
            const payload = {
              alias: form.alias.trim(),
              host: form.host.trim(),
              port: Number(form.port || 22),
              user: form.user.trim() || 'root',
              authKind: form.authKind,
              ...(form.authKind === 'password' ? { password: form.password } : {}),
              ...(form.authKind === 'key' ? { keyPath: form.keyPath.trim(), ...(form.passphrase ? { passphrase: form.passphrase } : {}) } : {}),
              ...(editingAlias ? { previousAlias: editingAlias } : {}),
            }
            await call('hostSave', payload)
            const list = await call('hosts')
            setHosts(list)
            setForm(emptyHostForm())
            setEditingAlias('')
            setHostsOpen(false)
            setHostNotice(`已保存主机「${payload.alias}」`)
            if (!host) {
              setHost(payload.alias)
              try {
                const home = await call('home', { host: payload.alias })
                setCwd(home.path)
                const listed = await call('list', { host: payload.alias, path: home.path })
                setEntries(listed.entries)
              } catch (cause) {
                setError(String(cause instanceof Error ? cause.message : cause))
              }
            }
          } catch (cause) {
            setError(String(cause instanceof Error ? cause.message : cause))
          } finally {
            setHostBusy(false)
          }
        }, [form, editingAlias, host])

        const removeHost = useCallback(async (alias) => {
          setHostBusy(true)
          setError('')
          setHostNotice('')
          try {
            const result = await call('hostRemove', { alias })
            setHosts(result.hosts)
            setHostNotice(`已删除主机「${alias}」`)
            if (host === alias) {
              setHost('')
              setCwd('')
              setEntries([])
            }
          } catch (cause) {
            setError(String(cause instanceof Error ? cause.message : cause))
          } finally {
            setHostBusy(false)
          }
        }, [host])

        const testHost = useCallback(async (alias) => {
          setHostBusy(true)
          setError('')
          setHostNotice('')
          try {
            const result = await call('hostTest', { alias })
            setHostNotice(`连接成功：${alias}（${result.ms}ms，家目录 ${result.home}）`)
          } catch (cause) {
            setError(String(cause instanceof Error ? cause.message : cause))
          } finally {
            setHostBusy(false)
          }
        }, [])

        const field = (name, control) => h(
          'div',
          { style: styles.field },
          h('span', { style: styles.label }, name),
          control,
        )

        const visibleHosts = useMemo(() => hosts.map((entry) => `${entry.alias} (${entry.user}@${entry.host})`), [hosts])



        return h(
          'div',
          { style: styles.root },
          h(
            'div',
            { style: styles.row },
            h(
              'select',
              { style: styles.select, value: host, onChange: switchHost, disabled: busy || hosts.length === 0 },
              hosts.length === 0 ? h('option', { value: '' }, '未配置 SSH 主机') : null,
              [...hosts.map((entry, index) => h('option', { key: entry.alias, value: entry.alias }, visibleHosts[index]))],
            ),
            h('button', { style: styles.button, onClick: () => go(dirnameOf(cwd)), disabled: busy || !host }, '上一级'),
            h('button', { style: styles.button, onClick: () => go(cwd), disabled: busy || !host }, '刷新'),
          ),
          h(
            'div',
            { style: styles.row },
            h('input', {
              style: styles.path,
              value: cwd,
              spellCheck: false,
              onChange: (event) => setCwd(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') go(cwd)
              },
            }),
            h('button', { style: styles.primary, onClick: addWorkspace, disabled: busy || !host || !cwd }, '挂载为工作区'),
          ),
          error ? h('div', { style: styles.error }, error) : null,
          notice ? h('div', { style: styles.notice }, notice) : null,
          h(
            'div',
            { style: styles.list },
            entries.length === 0
              ? h('div', { style: { ...styles.muted, padding: 10 } }, busy ? '正在读取…' : '空目录')
              : entries.map((entry) => h(
                'div',
                {
                  key: entry.name,
                  style: styles.item,
                  title: entry.type,
                  onClick: () => go(entry.type === 'directory' ? `${cwd.replace(/\/+$/, '')}/${entry.name}`.replace(/\/+/g, '/') : cwd),
                },
                h('span', null, entry.type === 'directory' ? '📁' : '📄'),
                h('span', null, entry.name),
              )),
          ),
          h(
            'div',
            { style: styles.mounts },
            h('div', { style: styles.muted }, '已挂载的远程目录'),
            mounts.length === 0
              ? h('div', { style: styles.muted }, '尚无挂载')
              : mounts.map((mount) => h(
                'div',
                { key: mount.id, style: styles.row },
                h('span', { style: { fontSize: 11, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }, title: mount.anchor }, `${mount.host}:${mount.remote}`),
                h('button', { style: styles.button, onClick: () => unmount(mount.id), disabled: busy }, '移除'),
              )),
          ),
          h(
            'div',
            { style: styles.section },
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.muted }, `主机（${hosts.length}）`),
              h('button', {
                style: styles.button,
                disabled: hostBusy,
                onClick: () => {
                  setHostsOpen(!hostsOpen)
                  setEditingAlias('')
                  setForm(emptyHostForm())
                  setHostNotice('')
                },
              }, hostsOpen ? '收起' : '＋ 添加主机'),
            ),
            hostNotice ? h('div', { style: styles.notice }, hostNotice) : null,
            hosts.map((entry) => h(
              'div',
              { key: entry.alias, style: styles.row },
              h('span', { style: { fontSize: 11, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }, title: `${entry.user}@${entry.host}:${entry.port}` }, entry.alias),
              h('span', { style: styles.badge }, entry.source === 'plugin' ? '插件' : 'dsh-ssh'),
              h('button', { style: styles.button, disabled: hostBusy, onClick: () => testHost(entry.alias) }, '测试'),
              h('button', { style: styles.button, disabled: hostBusy || entry.source !== 'plugin', onClick: () => editHost(entry) }, '编辑'),
              h('button', { style: styles.button, disabled: hostBusy || entry.source !== 'plugin', onClick: () => removeHost(entry.alias) }, '删除'),
            )),
            hostsOpen ? h(
              'div',
              { style: styles.form },
              h('div', { style: styles.title }, editingAlias ? `编辑主机「${editingAlias}」` : '添加主机'),
              field('别名', h('input', { style: styles.input, value: form.alias, spellCheck: false, placeholder: '例如 mybox', onChange: (event) => setForm({ ...form, alias: event.target.value }) })),
              field('主机', h('input', { style: styles.input, value: form.host, spellCheck: false, placeholder: '192.168.1.10 或域名', onChange: (event) => setForm({ ...form, host: event.target.value }) })),
              field('端口', h('input', { style: styles.input, value: form.port, onChange: (event) => setForm({ ...form, port: event.target.value }) })),
              field('用户', h('input', { style: styles.input, value: form.user, onChange: (event) => setForm({ ...form, user: event.target.value }) })),
              field('认证', h(
                'select',
                { style: styles.select, value: form.authKind, onChange: (event) => setForm({ ...form, authKind: event.target.value }) },
                h('option', { value: 'password' }, '密码'),
                h('option', { value: 'key' }, '私钥'),
                h('option', { value: 'none' }, '无（SSH agent）'),
              )),
              form.authKind === 'password'
                ? field('密码', h('input', { style: styles.input, type: 'password', value: form.password, onChange: (event) => setForm({ ...form, password: event.target.value }) }))
                : null,
              form.authKind === 'key'
                ? field('私钥', h('input', { style: styles.input, value: form.keyPath, spellCheck: false, placeholder: '~/.ssh/id_ed25519', onChange: (event) => setForm({ ...form, keyPath: event.target.value }) }))
                : null,
              form.authKind === 'key'
                ? field('口令', h('input', { style: styles.input, type: 'password', value: form.passphrase, onChange: (event) => setForm({ ...form, passphrase: event.target.value }) }))
                : null,
              h(
                'div',
                { style: styles.footer },
                h('button', {
                  style: styles.button,
                  disabled: hostBusy,
                  onClick: () => {
                    setHostsOpen(false)
                    setEditingAlias('')
                    setForm(emptyHostForm())
                  },
                }, '取消'),
                h('button', { style: styles.primary, disabled: hostBusy || !form.alias.trim() || !form.host.trim(), onClick: saveHost }, '保存'),
              ),
              h('div', { style: styles.muted }, '凭据以明文保存在 ~/.dsh/remote-workspaces-hosts.json（权限 0600），仅本机可读。'),
            ) : null,
          ),
        )
      }
    }

    exports.apply = function apply(ctx) {
      const disposers = []
      const Page = createPage(ctx)

      disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => '远程',
      }, PanelIcon)))

      disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({}),
      }, Page)))

      ctx.effect(() => () => {
        for (const dispose of disposers) dispose()
      }, 'remote-workspace: panel')
    }

    exports.inject = ['slots', 'layout', 'workspaces', 'connection']

    return module.exports
  },
})
