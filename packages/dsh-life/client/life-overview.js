/**
 * Client half of the "运行总览" screen — hand-written, ZERO build step.
 *
 * Format: dsh's web shell loads client modules through its own lazy-CJS table
 * (`window.__ModuleLoader__.load({ id, factory })`), and `require('react')` is
 * answered from the shell's shared module registry. A plain file like this one is
 * therefore a valid client module: no bundler, no JSX, no dependencies.
 *
 * Data comes from the Host route the other half registers (`/life/state.json`,
 * see lib/ui.js). Nothing is inlined here except labels and layout, so the screen
 * cannot show a story that the state files do not support.
 *
 * Registration: `shell.overlay` (verified in docs/dsh-ui-slots.md) and, when the
 * profile provides it, `settings.section` with the same component.
 */
window.__ModuleLoader__.load({
  id: 'dsh-life',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const STATE_URL = '/life/state.json'
    const REFRESH_MS = 30_000
    const MAX_COMMITMENTS = 3

    const palette = {
      root: {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: 9000,
        width: '320px',
        padding: '12px 14px',
        borderRadius: '10px',
        background: 'rgba(22,22,26,.94)',
        color: '#e9e9ec',
        font: '12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace',
        boxShadow: '0 8px 28px rgba(0,0,0,.38)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      title: { fontWeight: 600, fontSize: '12.5px', marginBottom: '8px', opacity: 0.95 },
      label: { color: '#9a9aa5' },
      section: { marginTop: '8px' },
      error: { color: '#ff9a8a' },
    }

    function text (value) {
      return value === null || value === undefined || value === '' ? '—' : String(value)
    }

    function when (iso) {
      if (typeof iso !== 'string' || !iso) return '未排'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '未排'
      return date.toLocaleString()
    }

    function useLifeState () {
      const [state, setState] = React.useState({ status: 'loading' })
      React.useEffect(() => {
        let alive = true
        const read = () => {
          fetch(STATE_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
            .then((response) => response.json())
            .then((payload) => {
              if (!alive) return
              if (payload && payload.ok) setState({ status: 'ok', life: payload })
              else setState({ status: 'error', error: text(payload && payload.error) })
            })
            .catch((err) => {
              if (alive) setState({ status: 'error', error: String((err && err.message) || err) })
            })
        }
        read()
        const timer = setInterval(read, REFRESH_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])
      return state
    }

    function row (key, label, value) {
      return React.createElement('div', { key }, [
        React.createElement('span', { key: 'l', style: palette.label }, label + ' '),
        React.createElement('span', { key: 'v' }, text(value)),
      ])
    }

    function LifeOverview () {
      const state = useLifeState()
      const children = []

      if (state.status === 'loading') {
        children.push(React.createElement('div', { key: 'loading', style: palette.label }, '读取中…'))
      } else if (state.status === 'error') {
        children.push(React.createElement('div', { key: 'error', style: palette.error }, '拿不到状态：' + text(state.error)))
      } else {
        const life = state.life
        const activity = life.activity
        const today = life.today || {}

        children.push(React.createElement('div', { key: 'doing', style: palette.section }, [
          React.createElement('div', { key: 'h', style: palette.label }, '现在在做什么'),
          React.createElement('div', { key: 'what' }, activity ? text(activity.what) : '没有正在进行的事'),
          activity && activity.why ? React.createElement('div', { key: 'why', style: palette.label }, '为什么：' + activity.why) : null,
          activity && activity.startedAt ? React.createElement('div', { key: 'since', style: palette.label }, '开始于 ' + when(activity.startedAt)) : null,
        ]))

        children.push(React.createElement('div', { key: 'today', style: palette.section }, [
          React.createElement('div', { key: 'h', style: palette.label }, '今天'),
          row('turns', '醒着回应', today.turns),
          row('wakes', '自主醒来', today.wakes),
          row('acts', '做完的事', today.activities),
          row('fails', '失败', today.failures),
        ]))

        const commitments = Array.isArray(life.openCommitments) ? life.openCommitments.slice(0, MAX_COMMITMENTS) : []
        children.push(React.createElement('div', { key: 'owed', style: palette.section }, [
          React.createElement('div', { key: 'h', style: palette.label }, '欠着的事'),
          commitments.length === 0
            ? React.createElement('div', { key: 'none', style: palette.label }, '没有')
            : React.createElement('div', { key: 'list' }, commitments.map((item, index) =>
                React.createElement('div', { key: 'c' + index }, '· ' + text(item.what) + (item.dueAt ? '（' + when(item.dueAt) + '）' : '')))),
        ]))

        children.push(React.createElement('div', { key: 'wake', style: palette.section }, [
          React.createElement('span', { key: 'l', style: palette.label }, '下次醒来 '),
          React.createElement('span', { key: 'v' }, when(life.nextWakeAt)),
          React.createElement('span', { key: 'c', style: palette.label }, '（今天已醒 ' + text(life.wakeCountToday) + ' 次）'),
        ]))
      }

      return React.createElement('div', { id: 'life-overview', style: palette.root }, [
        React.createElement('div', { key: 'title', style: palette.title },
          '生命 · 运行总览 · ' + text(state.status === 'ok' && state.life.identity ? state.life.identity.name : '')),
        ...children,
        React.createElement('div', { key: 'meta', style: { marginTop: '8px', opacity: 0.55 } },
          state.status === 'ok' ? '状态时间 ' + when(state.life.generatedAt) : '每 30 秒刷新'),
      ])
    }

    const inject = ['slots']

    function apply (ctx) {
      // shell.overlay: the shell-level slot proven in docs/dsh-ui-slots.md.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'life-overview',
        order: 1000,
      }, LifeOverview))

      // settings.section: same component, same component instance, zero build.
      // Guarded: a profile may never provide this slot, and a register() that the
      // slot rejects must not take the overlay down with it.
      try {
        ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register({ name: 'settings.section', id: 'life-overview', order: 900 }, LifeOverview)
          } catch (err) {
            return undefined
          }
        })
      } catch (err) {}
    }

    exports.name = 'dsh-life-ui'
    exports.inject = inject
    exports.apply = apply
    exports.LifeOverview = LifeOverview
    return module.exports
  },
})
