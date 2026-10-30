/**
 * Real life overview inside the dsh shell. The design stays in design/;
 * this client reads the Host projection and never supplies a pretend history.
 * The shell supplies React and owns navigation; no bundler or runtime dependency.
 */
window.__ModuleLoader__.load({
  id: 'dsh-life',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    const STATE_URL = '/life/state.json'
    const REFRESH_MS = 30_000
    const PANEL_ID = 'life-overview'
    const AVATAR_URL = '/life/avatar.png'
    const CSS = `
#life-overview{height:100%;min-height:0;width:100%;font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;text-align:left;color-scheme:light dark;--ac:#4f6fc0;--ac2:#7088c0;--deep:#1b2c61;--t:light-dark(#161c2c,#e9eef9);--m:light-dark(#6d7893,#8a95ad);--line:light-dark(#e9edf5,#1e2637);--soft:light-dark(#f6f9fd,#131a27);--bg:light-dark(#fff,#0e131d);--side:light-dark(#f4f7fc,#0b1017);--ok:light-dark(#15803d,#4ade80);--warn:light-dark(#a16207,#fbbf24);color:var(--t);background:var(--bg)}
#life-overview *{box-sizing:border-box}#life-overview button{font:inherit;cursor:pointer}#life-overview button:disabled{cursor:not-allowed;opacity:.45}#life-overview button:focus-visible,#life-overview a:focus-visible{outline:2px solid var(--ac2);outline-offset:3px}#life-overview svg{width:16px;height:16px;flex:none}#life-overview p{margin:0}#life-overview .life-app{display:flex;min-height:640px;height:100%;overflow:auto}#life-overview .life-nav{display:flex;flex-direction:column;gap:14px;width:202px;flex:none;padding:16px 12px;background:var(--side);border-right:1px solid var(--line)}#life-overview .life-id{display:flex;align-items:center;gap:9px;padding:10px 8px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}#life-overview .life-avatar{width:36px;height:36px;object-fit:contain;border-radius:10px;background:color-mix(in oklab,var(--ac2) 14%,transparent)}#life-overview .life-id strong{display:block;font-weight:600;overflow-wrap:anywhere}#life-overview .life-muted{color:var(--m);font-size:12px}#life-overview .life-navlist{display:flex;flex-direction:column;gap:4px}#life-overview .life-navi{display:flex;align-items:center;gap:9px;text-align:left;width:100%;padding:10px 11px;border:0;border-radius:9px;background:none;color:var(--m)}#life-overview .life-navi.active{background:color-mix(in oklab,var(--ac2) 16%,transparent);color:var(--t)}#life-overview .life-navfoot{margin-top:auto;display:grid;gap:6px;font-size:11px;color:var(--m)}#life-overview .life-main{flex:1;min-width:0;display:flex;flex-direction:column}#life-overview .life-bar{display:flex;align-items:center;flex-wrap:wrap;gap:15px;padding:15px 22px;border-bottom:1px solid var(--line)}#life-overview .life-bar h1{font-size:13px;font-weight:600;margin:0;margin-right:auto}#life-overview .life-axis{display:flex;gap:6px;font-size:11px;color:var(--m)}#life-overview .life-live{color:var(--ac2)}#life-overview .life-good{color:var(--ok)}#life-overview .life-warning{color:var(--warn)}#life-overview .life-icon{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--line);background:none;border-radius:9px;color:var(--m)}#life-overview .life-content{flex:1;display:flex;flex-direction:column;min-width:0}#life-overview .life-render{position:relative;display:grid;place-items:center;flex:1;min-height:250px;padding:24px 0 34px}#life-overview .life-halo{position:absolute;width:310px;height:260px;max-width:100%;background:radial-gradient(ellipse,color-mix(in oklab,var(--ac2) 17%,transparent),transparent 68%)}#life-overview .life-figure{position:relative;width:218px;height:218px;object-fit:contain;filter:drop-shadow(0 18px 26px color-mix(in oklab,var(--deep) 20%,transparent));animation:life-breathe 5s ease-in-out infinite}#life-overview .life-artnote{position:absolute;bottom:13px;color:var(--m);font-size:10px}#life-overview .life-art-fallback{width:218px;height:218px;display:grid;place-items:center;color:var(--ac2)}#life-overview .life-art-fallback svg{width:100px;height:100px}#life-overview .life-activity{text-align:center;padding:0 24px 20px}#life-overview .life-activity h2{font-size:18px;line-height:1.5;font-weight:600;margin:0 0 5px;overflow-wrap:anywhere}#life-overview .life-activity p{font-size:12px;color:var(--m);overflow-wrap:anywhere}#life-overview .life-next{margin-top:9px!important;color:var(--ac2)!important}#life-overview .life-day{margin:0 22px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--soft)}#life-overview .life-dayhead{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--m);font-size:12px}#life-overview .life-dayhead span:first-child{margin-right:auto}#life-overview .life-link{padding:0;border:0;background:none;color:var(--ac2);font-size:11px}#life-overview .life-events{list-style:none;margin:0;padding:0;display:grid;gap:8px}#life-overview .life-events li{display:flex;gap:13px;align-items:baseline;font-size:12px}#life-overview .life-events time{flex:none;color:var(--m);font-variant-numeric:tabular-nums}#life-overview .life-eventbody{min-width:0;overflow-wrap:anywhere}#life-overview .life-evidence{display:block;color:var(--m);font-size:10px}#life-overview .life-empty{padding:12px 0;color:var(--m);font-size:12px}#life-overview .life-actions{display:flex;justify-content:center;flex-wrap:wrap;gap:9px;padding:20px 18px}#life-overview .life-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 15px;border:1px solid var(--line);border-radius:10px;background:none;color:var(--t)}#life-overview .life-primary{background:linear-gradient(180deg,var(--ac2),var(--ac));color:#fff;border-color:transparent}#life-overview .life-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line);margin-top:auto}#life-overview .life-cell{padding:14px 16px;border-right:1px solid var(--line);display:grid;align-content:start;gap:5px;min-width:0;overflow-wrap:anywhere}#life-overview .life-cell:last-child{border-right:0}#life-overview .life-cell dt{font-size:11px;color:var(--m)}#life-overview .life-cell dd{font-size:12px;margin:0}#life-overview .life-cell small{font-size:10px;color:var(--m)}#life-overview .life-stamp{padding:8px 22px;border-top:1px solid var(--line);font-size:10px;color:var(--m);display:flex;flex-wrap:wrap;justify-content:space-between;gap:5px}#life-overview .life-message{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;flex-direction:column;gap:14px;min-height:350px;padding:30px}#life-overview .life-message h2{margin:0;font-size:19px}#life-overview .life-message p{color:var(--m);max-width:420px;overflow-wrap:anywhere}#life-overview .life-refresh-error{margin:12px 22px 0;padding:10px 14px;border:1px solid var(--warn);border-radius:10px;color:var(--warn);font-size:12px}#life-overview .life-skeleton{width:210px;height:14px;border-radius:7px;background:var(--line)}
@keyframes life-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}@media(prefers-reduced-motion:reduce){#life-overview .life-figure{animation:none}}@media(max-width:900px){#life-overview .life-nav{width:165px;padding:12px 8px}#life-overview .life-strip{grid-template-columns:repeat(2,minmax(0,1fr))}#life-overview .life-cell:nth-child(-n+2){border-bottom:1px solid var(--line)}}@media(max-width:600px){#life-overview .life-app{display:block;min-height:100%;overflow:visible}#life-overview .life-nav{width:auto;border-right:0;border-bottom:1px solid var(--line);padding:10px 14px;gap:8px}#life-overview .life-id{padding:0;border:0;background:none}#life-overview .life-avatar{width:30px;height:30px}#life-overview .life-navlist{flex-direction:row;overflow-x:auto;gap:2px}#life-overview .life-navi{width:auto;white-space:nowrap;padding:8px;font-size:11px}#life-overview .life-navi svg{display:none}#life-overview .life-navfoot{display:none}#life-overview .life-bar{padding:12px 15px;gap:10px}#life-overview .life-render{min-height:220px;padding-top:14px}#life-overview .life-figure{width:180px;height:180px}#life-overview .life-day{margin:0 14px}#life-overview .life-strip{grid-template-columns:repeat(2,minmax(0,1fr))}#life-overview .life-cell{padding:12px}#life-overview .life-stamp{padding:8px 14px}#life-overview .life-main{min-height:600px}}
`
    const paths = {
      home: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
      ledger: 'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5',
      chat: 'M21 11a9 9 0 0 1-9 9 9 9 0 0 1-4-.9L3 21l1.9-5A9 9 0 1 1 21 11z',
      works: 'M3 7h18v13H3z M7 7V3h10v4 M3 13h6l2 3h2l2-3h6',
      channels: 'M12 3v6 M5 17v4 M19 17v4 M5 17h14V9H5z',
      care: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
      pet: 'M3 3h18v14H3z M8 21h8 M12 17v4',
      pause: 'M8 5v14 M16 5v14',
      refresh: 'M20 7a9 9 0 1 0 1 8 M20 3v5h-5',
      fish: 'M4 12c5-9 12-9 16 0-4 9-11 9-16 0z M4 12L1 7v10z M15 10h.01',
    }
    function icon (name, size = 16) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[name] || paths.fish }))
    }
    function text (value, fallback = '—') { return value === null || value === undefined || value === '' ? fallback : String(value) }
    function time (iso) {
      const at = new Date(iso)
      return iso && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
    }
    function when (iso) {
      const at = new Date(iso)
      return iso && !Number.isNaN(at.getTime()) ? at.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未安排'
    }
    function duration (start, end) {
      const elapsed = Date.parse(end) - Date.parse(start)
      if (!Number.isFinite(elapsed) || elapsed < 0) return null
      const minutes = Math.floor(elapsed / 60000)
      return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`
    }

    function useLifeState () {
      const [state, setState] = React.useState({ status: 'loading', life: null })
      const [revision, retry] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        let busy = false
        const controller = new AbortController()
        const read = async () => {
          if (busy) return
          busy = true
          try {
            const response = await fetch(STATE_URL, { headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal })
            if (!response.ok) throw new Error('读取失败（' + response.status + '）')
            const payload = await response.json()
            if (!payload || !payload.ok) throw new Error('暂时无法读取生活记录，请检查存储后重试。')
            if (alive) setState({ status: 'ok', life: payload, error: null })
          } catch (err) {
            if (alive) setState((previous) => ({ status: 'error', life: previous.life, error: text(err && err.message, '连接中断') }))
          } finally { busy = false }
        }
        read()
        const timer = setInterval(read, REFRESH_MS)
        return () => { alive = false; controller.abort(); clearInterval(timer) }
      }, [revision])
      return [state, () => retry((value) => value + 1)]
    }

    function Avatar ({ className, name }) {
      const [failed, setFailed] = React.useState(false)
      return failed
        ? h('div', { className: className === 'life-figure' ? 'life-art-fallback' : 'life-avatar', role: 'img', 'aria-label': name + '的形象' }, icon('fish'))
        : h('img', { className, src: AVATAR_URL, alt: name + '的占位形象', onError: () => setFailed(true) })
    }
    const NAV = [['overview', 'home', '运行总览'], ['ledger', 'ledger', '生活账本'], ['chat', 'chat', '和它说话'], ['works', 'works', '作品与发布'], ['channels', 'channels', '渠道'], ['care', 'care', '照料设置'], ['pet', 'pet', '桌宠形态']]

    function LifeOverview ({ onChat } = {}) {
      const [state, retry] = useLifeState()
      const [expanded, setExpanded] = React.useState(false)
      const life = state.life
      const name = life?.identity?.name && life.identity.name !== 'unknown' ? life.identity.name : '我的鱼缸'
      const birth = life?.identity?.bornAt
      const age = birth ? Math.max(1, Math.floor((Date.parse(life.generatedAt) - Date.parse(birth)) / 86400000) + 1) : null
      const events = Array.isArray(life?.recentEvents) ? life.recentEvents : []
      const activity = life?.activity
      const activeFor = activity ? duration(activity.startedAt, life.generatedAt) : null
      const interest = life?.interests?.[0]
      const attention = life?.attention || { total: 0, approval: 0, unconfirmed: 0 }
      const living = !life ? (state.status === 'error' ? '未知' : '读取中') : life.lifeStatus === 'uninitialized' ? '等待开始' : activity ? '活动中' : '暂无活动'
      const today = () => {
        setExpanded(true)
        // This is a local view change. The target exists in this component.
        if (typeof document !== 'undefined') document.getElementById('life-today')?.scrollIntoView({ block: 'nearest' })
      }
      const button = (label, glyph, click, primary = false, disabled = false) => h('button', {
        type: 'button', className: 'life-button' + (primary ? ' life-primary' : ''), onClick: click, disabled,
        title: disabled ? '暂不可用' : undefined,
      }, icon(glyph), label)
      const cell = (title, content, hint, warn = false) => h('div', { className: 'life-cell' },
        h('dt', null, title), h('dd', { className: warn ? 'life-warning' : undefined }, content), hint ? h('small', null, hint) : null)
      let content
      if (!life) {
        content = h('div', { className: 'life-message', role: state.status === 'error' ? 'alert' : 'status' },
          h(Avatar, { className: 'life-figure', name }),
          h('h2', null, state.status === 'error' ? '暂时看不到它的近况' : '正在读取它的生活'),
          state.status === 'error' ? h('p', null, state.error) : h('div', { className: 'life-skeleton', 'aria-hidden': true }),
          state.status === 'error' ? button('重新连接', 'refresh', retry, true) : null)
      } else {
        content = h('div', { className: 'life-content', 'aria-busy': false },
          state.status === 'error' ? h('div', { className: 'life-refresh-error', role: 'alert' },
            '连接暂时中断，以下为上次读取的记录。 ', h('button', { className: 'life-link', type: 'button', onClick: retry }, '重试')) : null,
          h('div', { className: 'life-render' }, h('span', { className: 'life-halo', 'aria-hidden': true }),
            h(Avatar, { className: 'life-figure', name }), h('span', { className: 'life-artnote' }, '静态占位形象')),
          h('div', { className: 'life-activity' },
            h('h2', null, activity ? activity.what : life.lifeStatus === 'uninitialized' ? '它的生活，还没有开始' : '此刻没有正在进行的事'),
            h('p', null, activity ? [activeFor, activity.why].filter(Boolean).join(' · ') : '它需要几天积累经历，也会有安静的日子。'),
            activity?.evidenceCount > 0 ? h('p', null, '已记录 ' + activity.evidenceCount + ' 条活动证据') : null,
            life.nextStep ? h('p', { className: 'life-next' }, '下一步想做：' + life.nextStep.what) : null),
          h('section', { className: 'life-day', id: 'life-today', 'aria-label': '它的一天' },
            h('div', { className: 'life-dayhead' }, h('span', null, '它的一天'),
              h('span', null, '今天结束 ' + text(life.today?.activities, '0') + ' 次活动'),
              events.length > 3 ? h('button', { type: 'button', className: 'life-link', onClick: () => setExpanded(!expanded), 'aria-expanded': expanded }, expanded ? '收起' : '展开近况') : null),
            events.length ? h('ul', { className: 'life-events' }, events.slice(0, expanded ? 5 : 3).map((event, index) =>
              h('li', { key: event.at + ':' + index }, h('time', { dateTime: event.at }, time(event.at)),
                h('div', { className: 'life-eventbody' }, event.label,
                  event.evidenceCount > 0 ? h('span', { className: 'life-evidence' }, event.evidenceCount + ' 条证据已记录') : null))))
              : h('p', { className: 'life-empty' }, '今天还没有生活记录。等它开始第一件事，再回来看看。')),
          h('div', { className: 'life-actions' }, button('和它说话', 'chat', onChat, true, typeof onChat !== 'function'),
            button('看它干了什么', 'ledger', today), button('照料', 'care', undefined, false, true)),
          h('dl', { className: 'life-strip' },
            cell('状态变量', '身份 v' + text(life.identity?.revision, '0'), interest ? '兴趣：' + interest.topic : '兴趣正在积累'),
            cell('今日预算', life.wake?.maxPerDay === null ? '尚未设置唤醒额度' : '已醒 ' + text(life.wakeCountToday, '0') + ' / ' + text(life.wake?.maxPerDay) + ' 次', '费用尚无记录'),
            cell('它答应过', life.openCommitments?.[0]?.what || '没有未完成的约定', life.openCommitments?.[0]?.dueAt ? when(life.openCommitments[0].dueAt) : '它会把约定记在这里'),
            cell('需要你', attention.total ? [attention.approval ? attention.approval + ' 条草稿待确认' : '', attention.unconfirmed ? attention.unconfirmed + ' 条发布结果待核对' : ''].filter(Boolean).join('；') : '暂时没有需要你的事', null, attention.total > 0)),
          h('footer', { className: 'life-stamp' }, h('span', null, life.wake?.paused ? '自主唤醒已暂停' : life.wake?.enabled === false ? '自主唤醒已关闭' : '下次醒来：' + when(life.nextWakeAt)),
            h('span', null, '记录更新于 ' + time(life.generatedAt))))
      }
      return h('section', { id: 'life-overview', 'aria-label': '鱼缸' }, h('style', null, CSS),
        h('div', { className: 'life-app' },
          h('aside', { className: 'life-nav', 'aria-label': '鱼缸导航' },
            h('div', { className: 'life-id' }, h(Avatar, { className: 'life-avatar', name }),
              h('div', null, h('strong', null, name), h('div', { className: 'life-muted' }, 'lifeId ' + text(life?.identity?.lifeId)))),
            h('nav', { className: 'life-navlist' }, NAV.map(([id, glyph, label]) => h('button', {
              key: id, type: 'button', className: 'life-navi' + (id === 'overview' ? ' active' : ''),
              'aria-current': id === 'overview' ? 'page' : undefined,
              disabled: id !== 'overview' && !(id === 'chat' && typeof onChat === 'function'),
              title: id !== 'overview' && id !== 'chat' ? '暂不可用' : undefined,
              onClick: id === 'chat' ? onChat : undefined,
            }, icon(glyph), label))),
            h('div', { className: 'life-navfoot' }, h('span', null, age ? '相伴第 ' + age + ' 天' : '等待第一段经历'),
              h('p', null, '它需要几天才有自己的生活。'))),
          h('main', { className: 'life-main' },
            h('header', { className: 'life-bar' }, h('h1', null, '运行总览'),
              h('span', { className: 'life-axis' }, '生活', h('span', { className: 'life-live' }, living)),
              h('span', { className: 'life-axis' }, '系统', h('span', { className: state.status === 'error' ? 'life-warning' : 'life-good', title: '这里只确认生活记录可读取，模型与渠道状态尚未检查' }, state.status === 'error' ? '读取异常' : life ? '状态可读' : '检查中')),
              h('button', { type: 'button', className: 'life-icon', onClick: retry, 'aria-label': '刷新近况', title: '刷新近况' }, icon('refresh')),
              h('button', { type: 'button', className: 'life-icon', disabled: true, 'aria-label': '暂停', title: '暂停功能暂不可用' }, icon('pause'))), content)))
    }

    const inject = ['slots', 'layout']
    function apply (ctx) {
      // Same keyed main + sidebar entry contract as dsh-client-ui-schedule.
      // A page belongs to the shell; an always-on fixed overlay obscures chat.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID,
        inject: () => ({ onChat: () => ctx.layout.selectPanel(null) }),
      }, LifeOverview))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '鱼缸',
      }, ({ size = 16 }) => icon('fish', size)))
    }
    exports.name = 'dsh-life-ui'
    exports.inject = inject
    exports.apply = apply
    exports.LifeOverview = LifeOverview
    return module.exports
  },
})
