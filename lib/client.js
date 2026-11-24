// dsh-fork-sync 前端：在「插件」页的插件详情里加一段 Fork Sync 区块
window.__ModuleLoader__.load({
  id: 'dsh-fork-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const styles = {
      box: { marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '10px' },
      head: { display: 'flex', alignItems: 'center', gap: '10px' },
      title: { margin: 0, fontSize: '14px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      pre: {
        margin: 0, padding: '10px 12px', maxHeight: '320px', overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px',
        lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.04))',
        color: 'var(--dsw-alias-label-secondary)', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.08))',
      },
      row: { display: 'flex', gap: '8px', alignItems: 'center' },
      btn: {
        padding: '5px 12px', fontSize: '12px', borderRadius: '7px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06))',
        color: 'var(--dsw-alias-label-primary)',
      },
      btnPrimary: {
        padding: '5px 12px', fontSize: '12px', borderRadius: '7px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-business-primary, #7aaaff)',
        background: 'var(--dsw-alias-state-business-primary, #7aaaff)',
        color: '#fff',
      },
      err: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #f87171)' },
    }

    function Section(props) {
      const subject = props && props.subject
      const pkg = subject && (subject.pkg || subject.row)
      const name = pkg && (pkg.name || pkg.pkg?.name)
      const [report, setReport] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const res = await fetch('/fork-sync/report', { cache: 'no-store' })
          setReport(await res.text())
        } catch (e) {
          setError(String(e && e.message || e))
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      if (!name) return null
      const idx = report.indexOf('## ' + name + '\n')
      let chunk
      if (name === 'dsh-fork-sync' || idx < 0) {
        // 自己这一页：展示完整报告；其他未追踪的插件：隐藏
        if (name !== 'dsh-fork-sync' && idx < 0) return null
        chunk = report
      } else {
        const nextIdx = report.indexOf('\n## ', idx + 3)
        chunk = nextIdx < 0 ? report.slice(idx) : report.slice(idx, nextIdx)
      }

      const run = async (path, label) => {
        setBusy(label)
        setError('')
        try {
          const res = await fetch(path, { method: 'POST' })
          const body = await res.text()
          if (!res.ok) {
            let msg = body
            try { const j = JSON.parse(body); if (j && j.error) msg = j.error } catch {}
            setError(msg.slice(0, 300))
          }
          await load()
        } catch (e) {
          setError(String(e && e.message || e))
        } finally {
          setBusy('')
        }
      }

      return h('div', { style: styles.box },
        h('div', { style: styles.head },
          h('h4', { style: styles.title }, 'Fork Sync'),
          h('span', { style: styles.hint }, '本地 fork 与 npm 上游对比'),
        ),
        h('div', { style: styles.row },
          h('button', { style: styles.btnPrimary, disabled: !!busy, onClick: () => run('/fork-sync/check', 'check') },
            busy === 'check' ? '检查中…' : '立即检查'),
          h('button', { style: styles.btn, disabled: !!busy, onClick: () => run('/fork-sync/apply', 'apply') },
            busy === 'apply' ? '合并中…' : '合并安全项'),
          h('button', { style: styles.btn, disabled: !!busy, onClick: () => run('/fork-sync/conflicts', 'conflicts') },
            busy === 'conflicts' ? '生成中…' : '生成冲突分析'),
          h('button', { style: styles.btn, disabled: !!busy, onClick: load }, '刷新报告'),
        ),
        error ? h('div', { style: styles.err }, error) : null,
        h('pre', { style: styles.pre }, chunk.trim()),
      )
    }


    function SyncModal() {
      const [status, setStatus] = React.useState(null)
      const [report, setReport] = React.useState('')
      const load = React.useCallback(async () => {
        try {
          const res = await fetch('/fork-sync/status', { cache: 'no-store' })
          const st = await res.json()
          setStatus(st)
          if (st && st.needsAck) {
            const r = await fetch('/fork-sync/report', { cache: 'no-store' })
            setReport(await r.text())
          }
        } catch (e) {}
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, 60000)
        return () => clearInterval(timer)
      }, [load])
      React.useEffect(() => {
        if (!status || !status.needsAck) return undefined
        function stop(event) { event.preventDefault(); event.stopPropagation() }
        document.addEventListener('keydown', stop, true)
        return () => document.removeEventListener('keydown', stop, true)
      }, [status])
      if (!status || !status.needsAck) return null
      const summary = report.split('\n').filter((line) => line.startsWith('## ') || line.includes('→ 最新')).slice(0, 12).join('\n')
      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        h('div', { style: { width: 'min(620px, 90vw)', maxHeight: '80vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1, #1b1b1e)', color: 'var(--dsw-alias-label-primary, #f4f4f5)', border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))', borderRadius: '12px', padding: '18px 20px', boxShadow: '0 24px 80px rgba(0,0,0,.5)' } },
          h('h3', { style: { margin: '0 0 8px', fontSize: '15px', fontWeight: 600 } }, '本地插件有上游更新'),
          h('p', { style: { margin: '0 0 10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #a1a1aa)' } }, '每周一自动检查；确认后本次提醒才会关闭。'),
          h('pre', { style: { margin: 0, padding: '10px 12px', fontSize: '11.5px', lineHeight: 1.6, whiteSpace: 'pre-wrap', background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.04))', borderRadius: '8px', maxHeight: '46vh', overflow: 'auto' } }, summary || '（报告为空）'),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '14px' } },
            h('button', {
              style: { padding: '6px 16px', fontSize: '12px', borderRadius: '7px', cursor: 'pointer', border: '1px solid var(--dsw-alias-state-business-primary, #7aaaff)', background: 'var(--dsw-alias-state-business-primary, #7aaaff)', color: '#fff' },
              onClick: async function () {
                try { await fetch('/fork-sync/ack', { method: 'POST' }) } catch (e) {}
                setStatus({ needsAck: false })
              },
            }, '我知道了'),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'fork-sync-section',
          order: 100,
        }, Section))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'fork-sync-modal',
          order: 900,
        }, SyncModal))
      },
    }
  },
})
