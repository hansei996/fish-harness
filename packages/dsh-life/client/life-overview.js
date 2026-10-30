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
    const LEDGER_URL = '/api/life/ledger'
    const DRAFTS_URL = '/api/life/bilibili-drafts'
    const EXPORT_URL = '/api/life/bilibili-export'
    const CSS = `
#life-overview{height:100%;min-height:0;width:100%;font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;text-align:left;color-scheme:light dark;--ac:#4f6fc0;--ac2:#7088c0;--deep:#1b2c61;--t:light-dark(#161c2c,#e9eef9);--m:light-dark(#6d7893,#8a95ad);--line:light-dark(#e9edf5,#1e2637);--soft:light-dark(#f6f9fd,#131a27);--bg:light-dark(#fff,#0e131d);--side:light-dark(#f4f7fc,#0b1017);--ok:light-dark(#15803d,#4ade80);--warn:light-dark(#a16207,#fbbf24);color:var(--t);background:var(--bg)}
#life-overview *{box-sizing:border-box}#life-overview button{font:inherit;cursor:pointer}#life-overview button:disabled{cursor:not-allowed;opacity:.45}#life-overview button:focus-visible,#life-overview a:focus-visible{outline:2px solid var(--ac2);outline-offset:3px}#life-overview svg{width:16px;height:16px;flex:none}#life-overview p{margin:0}#life-overview .life-app{display:flex;min-height:640px;height:100%;overflow:auto}#life-overview .life-nav{display:flex;flex-direction:column;gap:14px;width:202px;flex:none;padding:16px 12px;background:var(--side);border-right:1px solid var(--line)}#life-overview .life-id{display:flex;align-items:center;gap:9px;padding:10px 8px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}#life-overview .life-avatar{width:36px;height:36px;object-fit:contain;border-radius:10px;background:color-mix(in oklab,var(--ac2) 14%,transparent)}#life-overview .life-id strong{display:block;font-weight:600;overflow-wrap:anywhere}#life-overview .life-muted{color:var(--m);font-size:12px}#life-overview .life-navlist{display:flex;flex-direction:column;gap:4px}#life-overview .life-navi{display:flex;align-items:center;gap:9px;text-align:left;width:100%;padding:10px 11px;border:0;border-radius:9px;background:none;color:var(--m)}#life-overview .life-navi.active{background:color-mix(in oklab,var(--ac2) 16%,transparent);color:var(--t)}#life-overview .life-navfoot{margin-top:auto;display:grid;gap:6px;font-size:11px;color:var(--m)}#life-overview .life-main{flex:1;min-width:0;display:flex;flex-direction:column}#life-overview .life-bar{display:flex;align-items:center;flex-wrap:wrap;gap:15px;padding:15px 22px;border-bottom:1px solid var(--line)}#life-overview .life-bar h1{font-size:13px;font-weight:600;margin:0;margin-right:auto}#life-overview .life-axis{display:flex;gap:6px;font-size:11px;color:var(--m)}#life-overview .life-live{color:var(--ac2)}#life-overview .life-good{color:var(--ok)}#life-overview .life-warning{color:var(--warn)}#life-overview .life-icon{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--line);background:none;border-radius:9px;color:var(--m)}#life-overview .life-content{flex:1;display:flex;flex-direction:column;min-width:0}#life-overview .life-render{position:relative;display:grid;place-items:center;flex:1;min-height:250px;padding:24px 0 34px}#life-overview .life-halo{position:absolute;width:310px;height:260px;max-width:100%;background:radial-gradient(ellipse,color-mix(in oklab,var(--ac2) 17%,transparent),transparent 68%)}#life-overview .life-figure{position:relative;width:218px;height:218px;object-fit:contain;filter:drop-shadow(0 18px 26px color-mix(in oklab,var(--deep) 20%,transparent));animation:life-breathe 5s ease-in-out infinite}#life-overview .life-artnote{position:absolute;bottom:13px;color:var(--m);font-size:10px}#life-overview .life-art-fallback{width:218px;height:218px;display:grid;place-items:center;color:var(--ac2)}#life-overview .life-art-fallback svg{width:100px;height:100px}#life-overview .life-activity{text-align:center;padding:0 24px 20px}#life-overview .life-activity h2{font-size:18px;line-height:1.5;font-weight:600;margin:0 0 5px;overflow-wrap:anywhere}#life-overview .life-activity p{font-size:12px;color:var(--m);overflow-wrap:anywhere}#life-overview .life-next{margin-top:9px!important;color:var(--ac2)!important}#life-overview .life-day{margin:0 22px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--soft)}#life-overview .life-dayhead{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--m);font-size:12px}#life-overview .life-dayhead span:first-child{margin-right:auto}#life-overview .life-link{padding:0;border:0;background:none;color:var(--ac2);font-size:11px}#life-overview .life-events{list-style:none;margin:0;padding:0;display:grid;gap:8px}#life-overview .life-events li{display:flex;gap:13px;align-items:baseline;font-size:12px}#life-overview .life-events time{flex:none;color:var(--m);font-variant-numeric:tabular-nums}#life-overview .life-eventbody{min-width:0;overflow-wrap:anywhere}#life-overview .life-evidence{display:block;color:var(--m);font-size:10px}#life-overview .life-empty{padding:12px 0;color:var(--m);font-size:12px}#life-overview .life-actions{display:flex;justify-content:center;flex-wrap:wrap;gap:9px;padding:20px 18px}#life-overview .life-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 15px;border:1px solid var(--line);border-radius:10px;background:none;color:var(--t)}#life-overview .life-primary{background:linear-gradient(180deg,var(--ac2),var(--ac));color:#fff;border-color:transparent}#life-overview .life-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line);margin-top:auto}#life-overview .life-cell{padding:14px 16px;border-right:1px solid var(--line);display:grid;align-content:start;gap:5px;min-width:0;overflow-wrap:anywhere}#life-overview .life-cell:last-child{border-right:0}#life-overview .life-cell dt{font-size:11px;color:var(--m)}#life-overview .life-cell dd{font-size:12px;margin:0}#life-overview .life-cell small{font-size:10px;color:var(--m)}#life-overview .life-stamp{padding:8px 22px;border-top:1px solid var(--line);font-size:10px;color:var(--m);display:flex;flex-wrap:wrap;justify-content:space-between;gap:5px}#life-overview .life-message{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;flex-direction:column;gap:14px;min-height:350px;padding:30px}#life-overview .life-message h2{margin:0;font-size:19px}#life-overview .life-message p{color:var(--m);max-width:420px;overflow-wrap:anywhere}#life-overview .life-refresh-error{margin:12px 22px 0;padding:10px 14px;border:1px solid var(--warn);border-radius:10px;color:var(--warn);font-size:12px}#life-overview .life-skeleton{width:210px;height:14px;border-radius:7px;background:var(--line)}
@keyframes life-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}@media(prefers-reduced-motion:reduce){#life-overview .life-figure{animation:none}}@media(max-width:900px){#life-overview .life-nav{width:165px;padding:12px 8px}#life-overview .life-strip{grid-template-columns:repeat(2,minmax(0,1fr))}#life-overview .life-cell:nth-child(-n+2){border-bottom:1px solid var(--line)}}@media(max-width:600px){#life-overview .life-app{display:block;min-height:100%;overflow:visible}#life-overview .life-nav{width:auto;border-right:0;border-bottom:1px solid var(--line);padding:10px 14px;gap:8px}#life-overview .life-id{padding:0;border:0;background:none}#life-overview .life-avatar{width:30px;height:30px}#life-overview .life-navlist{flex-direction:row;overflow-x:auto;gap:2px}#life-overview .life-navi{width:auto;white-space:nowrap;padding:8px;font-size:11px}#life-overview .life-navi svg{display:none}#life-overview .life-navfoot{display:none}#life-overview .life-bar{padding:12px 15px;gap:10px}#life-overview .life-render{min-height:220px;padding-top:14px}#life-overview .life-figure{width:180px;height:180px}#life-overview .life-day{margin:0 14px}#life-overview .life-strip{grid-template-columns:repeat(2,minmax(0,1fr))}#life-overview .life-cell{padding:12px}#life-overview .life-stamp{padding:8px 14px}#life-overview .life-main{min-height:600px}}
#life-overview .life-view{flex:1;min-height:0;padding:22px;overflow:auto}#life-overview .life-view[hidden]{display:none}#life-overview .life-panel-heading{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:20px}#life-overview .life-panel-heading h2{font-size:20px;margin:0 0 5px}#life-overview .life-panel-heading p{color:var(--m);font-size:12px}#life-overview .life-two-col{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:16px}#life-overview .life-card{padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--soft);min-width:0}#life-overview .life-card h3{font-size:16px;overflow-wrap:anywhere}#life-overview .life-card h4{font-size:12px;margin:20px 0 8px}#life-overview .life-cardtitle{display:flex;justify-content:space-between;gap:12px;font-weight:600;margin-bottom:15px}#life-overview .life-cardtitle small{font-weight:400;color:var(--m)}#life-overview .life-filters{display:flex;gap:7px;flex-wrap:wrap;margin:16px 0}#life-overview .life-chip{border:1px solid var(--line);border-radius:20px;padding:6px 12px;color:var(--m);background:transparent}#life-overview .life-chip.selected{border-color:var(--ac2);color:var(--t);background:color-mix(in oklab,var(--ac2) 15%,transparent)}#life-overview .life-ledger-list,#life-overview .life-draft-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}#life-overview .life-ledger-row{display:grid;grid-template-columns:1fr auto;gap:5px 10px;width:100%;padding:12px;border:1px solid transparent;border-radius:9px;background:var(--bg);color:var(--t);text-align:left}#life-overview .life-ledger-row.selected{border-color:var(--ac2)}#life-overview .life-ledger-row time{color:var(--m);font-size:11px}#life-overview .life-kind{font-size:10px;color:var(--ac2)}#life-overview .life-ledger-summary{grid-column:1/-1;overflow-wrap:anywhere}#life-overview .life-ledger-summary em{font-style:normal;font-size:10px;margin-left:8px}#life-overview .life-detail-copy{margin-top:12px;overflow-wrap:anywhere}#life-overview .life-proof-list{padding-left:18px;max-height:240px;overflow:auto}#life-overview .life-proof-list code{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}#life-overview .life-related{list-style:none;padding:0 0 0 14px;border-left:2px solid var(--line)}#life-overview .life-related li{display:grid;gap:4px;padding:8px 0 14px;overflow-wrap:anywhere}#life-overview .life-related time,#life-overview .life-related small{color:var(--m);font-size:10px}#life-overview .life-pagination{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px}#life-overview .life-panel-footnote{color:var(--m);font-size:11px;margin-top:18px}#life-overview .life-panel-error,#life-overview .life-panel-warning{padding:12px;border-radius:8px;background:color-mix(in oklab,var(--warn) 8%,var(--bg));color:var(--warn);font-size:12px;overflow-wrap:anywhere;margin:12px 0}#life-overview .life-chat-intro{display:flex;align-items:center;gap:12px;margin-bottom:20px}#life-overview .life-field{display:grid;gap:8px;margin-bottom:17px;font-size:12px}#life-overview input,#life-overview textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--t);font:inherit;resize:vertical}#life-overview input:focus,#life-overview textarea:focus{outline:2px solid var(--ac2);outline-offset:1px}#life-overview .life-field small{color:var(--m);font-size:11px}#life-overview .life-commitments{list-style:none;padding:0;margin:0}#life-overview .life-commitments li{display:grid;gap:5px;padding:12px 0;border-bottom:1px solid var(--line)}#life-overview .life-commitments small{color:var(--m)}#life-overview .life-draft-layout{display:grid;grid-template-columns:minmax(190px,.7fr) minmax(0,2fr);gap:16px}#life-overview .life-draft-list{margin-top:14px}#life-overview .life-draft-card{display:grid;gap:8px;width:100%;text-align:left;padding:13px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--t);overflow-wrap:anywhere}#life-overview .life-draft-card.selected{border-color:var(--ac2)}#life-overview .life-draft-card small{font-size:10px;color:var(--m)}#life-overview .life-draft-card span,#life-overview .life-status-badge{font-size:10px;color:var(--warn)}#life-overview .life-status-badge{padding:5px 10px;border:1px solid var(--line);border-radius:20px;white-space:nowrap}#life-overview .life-form-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:20px 0 16px}#life-overview a.life-button{text-decoration:none}#life-overview a[aria-disabled=true]{opacity:.4;pointer-events:none}#life-overview .life-source-note{display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:11px;padding:12px 0;color:var(--m)}#life-overview .life-save-notice{color:var(--ok);margin-top:12px;font-size:12px}#life-overview .life-nav-badge{margin-left:auto;border-radius:20px;padding:0 5px;color:#fff;background:var(--ac);font-size:10px}
#life-overview{container-type:inline-size}@container(max-width:850px){#life-overview .life-nav{width:155px}#life-overview .life-two-col{grid-template-columns:1fr}#life-overview .life-draft-layout{grid-template-columns:1fr}#life-overview .life-draft-list{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}}@container(max-width:600px){#life-overview .life-app{display:block}#life-overview .life-nav{width:auto;padding:10px 14px;border-right:0;border-bottom:1px solid var(--line)}#life-overview .life-id{padding:0;border:0;background:none}#life-overview .life-navlist{flex-direction:row;overflow-x:auto}#life-overview .life-navi{width:auto;white-space:nowrap;padding:8px;font-size:11px}#life-overview .life-navi svg{display:none}#life-overview .life-navfoot{display:none}#life-overview .life-view{padding:14px}#life-overview .life-panel-heading{flex-wrap:wrap}#life-overview .life-card{padding:14px}#life-overview .life-strip{grid-template-columns:repeat(2,minmax(0,1fr))}}
#life-overview .life-ledger-back{display:none;margin-bottom:16px}@container(max-width:850px){#life-overview .life-ledger-back{display:inline-flex}#life-overview .life-ledger-columns[data-selected=true] .life-ledger-index{display:none}#life-overview .life-ledger-columns[data-selected=false] .life-ledger-detail{display:none}}@container(max-width:600px){#life-overview .life-bar button:disabled{display:none}}
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

    async function ownerRequest (url, options = {}) {
      if (typeof url !== 'string' || ![LEDGER_URL, DRAFTS_URL, EXPORT_URL].some((base) => url === base || url.startsWith(base + '?'))) throw new Error('只允许访问本机鱼缸接口。')
      const response = await fetch(url, { ...options, cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok || !payload?.ok) {
        const messages = {
          'life/ledger-cursor-expired': '记录已更新，请返回第一页重新查看。',
          'life/bilibili-version-conflict': '这份草稿已被修改。请保留当前文字，重新载入最新版本后再保存。',
          'life/bilibili-request-conflict': '上次保存已经完成，请重新载入草稿后继续修改。',
          'life/bilibili-source-unavailable': '关联的生活记录已不可用，请重新选择来源。',
          'life/bilibili-draft-limit': '本地草稿数量已达到上限。',
          'life/bilibili-invalid-field': '请检查标题、简介和视频文件名的长度。',
        }
        throw new Error(response.status === 401 || response.status === 403 ? '连接已失效，请重新打开 dsh 页面后重试。' : messages[payload?.error] || '操作未完成，请检查填写内容后重试。')
      }
      return payload
    }
    function useOwnerDocument (url, active, epoch = 0) {
      const [value, setValue] = React.useState({ status: 'idle', data: null })
      const [revision, reload] = React.useState(0)
      React.useEffect(() => {
        if (!active) return
        const controller = new AbortController()
        setValue({ status: 'loading', data: null })
        ownerRequest(url, { signal: controller.signal }).then((data) => {
          if (!controller.signal.aborted) setValue({ status: 'ok', data })
        }).catch((error) => {
          if (!controller.signal.aborted) setValue({ status: 'error', data: null, error: error.message })
        })
        return () => controller.abort()
      }, [url, active, epoch, revision])
      return [value, () => reload((n) => n + 1)]
    }
    const KIND = { born: '出生', 'activity-start': '开始活动', 'activity-end': '活动结束', interest: '兴趣', skill: '技能', commitment: '新约定', 'commitment-settled': '约定进展', wake: '自主醒来', turn: '回应', publish: '投稿记录', 'identity-change': '身份变化', encounter: '关系互动' }
    const CATEGORIES = [['all', '全部'], ['activity', '活动'], ['interest', '兴趣与技能'], ['commitment', '约定'], ['turn', '回应与唤醒'], ['publish', '投稿']]
    function loadNotice (resource, retry) {
      if (resource.status === 'loading' || resource.status === 'idle') return h('p', { className: 'life-empty', role: 'status' }, '正在读取…')
      if (resource.status === 'error') return h('div', { className: 'life-panel-error', role: 'alert' }, resource.error, ' ', h('button', { type: 'button', className: 'life-link', onClick: retry }, '重试'))
      return null
    }
    function LedgerPanel ({ active, epoch, onDraft }) {
      const [category, setCategory] = React.useState('all')
      const [cursor, setCursor] = React.useState('')
      const [back, setBack] = React.useState([])
      const [selected, select] = React.useState('')
      const [list, reload] = useOwnerDocument(LEDGER_URL + '?category=' + category + '&cursor=' + encodeURIComponent(cursor), active, epoch)
      const [detail, retryDetail] = useOwnerDocument(LEDGER_URL + '?event=' + encodeURIComponent(selected), active && !!selected, epoch)
      const event = detail.data?.event
      function reset (value = category) { setCategory(value); setCursor(''); setBack([]); select(''); reload() }
      return h('section', { className: 'life-view', hidden: !active, 'aria-label': '生活账本' },
        h('div', { className: 'life-panel-heading' }, h('div', null, h('h2', null, '生活账本'), h('p', null, '留下发生过的事，也留下没做成的事。')), h('button', { className: 'life-button', type: 'button', onClick: () => reset() }, icon('refresh'), '刷新账本')),
        h('div', { className: 'life-filters', role: 'group', 'aria-label': '记录类别' }, CATEGORIES.map(([value, label]) => h('button', { type: 'button', key: value, className: 'life-chip' + (category === value ? ' selected' : ''), 'aria-pressed': category === value, onClick: () => reset(value) }, label))),
        h('div', { className: 'life-two-col life-ledger-columns', 'data-selected': !!selected },
          h('section', { className: 'life-card life-ledger-index', 'aria-label': '记录列表' },
            h('div', { className: 'life-cardtitle' }, '最近事件', list.data ? h('small', null, '共 ' + list.data.total + ' 条') : null),
            loadNotice(list, () => reset()),
            list.data?.items.length ? h('ol', { className: 'life-ledger-list' }, list.data.items.map((item) => h('li', { key: item.id },
              h('button', { className: 'life-ledger-row' + (selected === item.id ? ' selected' : ''), type: 'button', onClick: () => select(item.id), 'aria-pressed': selected === item.id },
                h('time', { dateTime: item.at }, when(item.at)), h('span', { className: 'life-kind' }, KIND[item.kind] || '记录'),
                h('span', { className: 'life-ledger-summary' }, item.label, item.outcome === 'failed' ? h('em', { className: 'life-warning' }, '未完成') : null))))) : list.status === 'ok' ? h('p', { className: 'life-empty' }, '这一类还没有记录。') : null,
            h('div', { className: 'life-pagination' }, h('button', { className: 'life-button', type: 'button', disabled: !back.length || list.status === 'loading', onClick: () => { setCursor(back.at(-1)); setBack(back.slice(0, -1)); select('') } }, '上一页'),
              h('span', { className: 'life-muted' }, '第 ' + (back.length + 1) + ' 页'),
              h('button', { className: 'life-button', type: 'button', disabled: !list.data?.nextCursor || list.status === 'loading', onClick: () => { setBack([...back, cursor]); setCursor(list.data.nextCursor); select('') } }, '下一页'))),
          h('section', { className: 'life-card life-ledger-detail', 'aria-label': '记录详情' },
            h('button', { className: 'life-button life-ledger-back', type: 'button', onClick: () => select('') }, '返回记录列表'),
            h('div', { className: 'life-cardtitle' }, '原因与关联记录'),
            !selected ? h('p', { className: 'life-empty' }, '选择左侧一条记录，查看原因、证据和同一活动的后续。') : loadNotice(detail, retryDetail),
            event ? h(React.Fragment, null, h('h3', null, event.label), h('p', { className: 'life-muted' }, when(event.at)),
              event.why ? h('p', { className: 'life-detail-copy' }, '当时的原因：' + event.why) : null,
              event.nextStep ? h('p', { className: 'life-detail-copy' }, '留下的下一步：' + event.nextStep) : null,
              h('h4', null, '证据记录'), event.evidence.length ? h('ul', { className: 'life-proof-list' }, event.evidence.map((proof, i) => h('li', { key: i }, h('code', null, proof)))) : h('p', { className: 'life-muted' }, '这条记录没有附带证据正文。'),
              detail.data.related.length > 1 ? h(React.Fragment, null, h('h4', null, '同一活动的记录'), h('ol', { className: 'life-related' }, detail.data.related.map((item) => h('li', { key: item.id }, h('time', null, when(item.at)), h('span', null, item.label), item.nextStep ? h('small', null, '下一步：' + item.nextStep) : null)))) : null,
              event.canDraft ? h('button', { type: 'button', className: 'life-button life-primary', onClick: () => onDraft(event) }, '用这条记录准备 B 站草稿') : null) : null)),
        h('p', { className: 'life-panel-footnote' }, '记录按发生顺序保留；更正应追加记录。这里展示原因摘要和证据，不展示隐藏推理。'))
    }
    function chatPrompt (mode, message) {
      const body = String(message || '').trim()
      if (!body || body.length > 4000) throw new Error('请填写 1–4000 字的内容。')
      const prefix = mode === 'promise' ? '这是我想和你约定的一件事。请核对已有承诺，避免重复；确认后用 life_promise 记下，并告诉我是否记录成功：' : mode === 'suggestion' ? '这是给你的一个建议，你可以根据当前状态决定是否采纳：' : '主人留言：'
      return prefix + '\n\n' + body
    }
    function ChatPanel ({ active, life, onChat, onCompose }) {
      const [mode, setMode] = React.useState('talk')
      const [message, setMessage] = React.useState('')
      const [notice, setNotice] = React.useState('')
      return h('section', { className: 'life-view', hidden: !active, 'aria-label': '和它说话' },
        h('div', { className: 'life-panel-heading' }, h('div', null, h('h2', null, '和它说话'), h('p', null, '说句话、提个建议，或者约定下一件事。')), h('button', { type: 'button', className: 'life-button', onClick: onChat }, '继续现有会话')),
        h('div', { className: 'life-two-col' },
          h('div', { className: 'life-card' }, h('div', { className: 'life-chat-intro' }, h(Avatar, { className: 'life-avatar', name: life?.identity?.name || '它' }), h('p', null, life?.activity ? '它正在：' + life.activity.what : '它现在没有正在进行的活动。')),
            life?.activity ? h('div', { className: 'life-panel-warning' }, '准备留言不会打断当前活动。进入会话后，再由你确认发送或排队。') : null,
            h('div', { className: 'life-filters', role: 'group', 'aria-label': '留言类型' }, [['talk', '说点什么'], ['suggestion', '提个建议'], ['promise', '约定一件事']].map(([value, label]) => h('button', { type: 'button', key: value, className: 'life-chip' + (mode === value ? ' selected' : ''), 'aria-pressed': mode === value, onClick: () => setMode(value) }, label))),
            h('label', { className: 'life-field' }, h('span', null, '想对它说的话'), h('textarea', { value: message, maxLength: 4000, rows: 7, placeholder: mode === 'promise' ? '例如：明天一起整理这次实验的结果…' : '和它说点什么…', onChange: (e) => setMessage(e.target.value) })),
            h('p', { className: 'life-muted' }, mode === 'promise' ? '这一步只准备消息；发送并得到确认后，约定才会写入账本。' : '内容会带入 dsh 会话输入框，由你确认发送。'),
            h('button', { type: 'button', className: 'life-button life-primary', disabled: !message.trim() || !onCompose, onClick: () => {
              try { onCompose(chatPrompt(mode, message)); setNotice('已打开会话，请检查输入框后发送。') } catch (err) { setNotice(err.message) }
            } }, '带到会话'), notice ? h('p', { role: 'status', className: 'life-muted' }, notice) : null),
          h('div', { className: 'life-card' }, h('div', { className: 'life-cardtitle' }, '它答应过的事'),
            life?.openCommitments?.length ? h('ul', { className: 'life-commitments' }, life.openCommitments.map((item, i) => h('li', { key: i }, h('span', null, item.what), h('small', null, item.dueAt ? when(item.dueAt) : '未约定时间')))) : h('p', { className: 'life-empty' }, '目前没有未完成的约定。'),
            life?.nextStep ? h(React.Fragment, null, h('h4', null, '它想继续的下一步'), h('p', null, life.nextStep.what)) : null)))
    }
    function freshDraft () { return { id: null, title: '', description: '', tags: '', videoName: '', sourceEventIds: [], requestId: crypto.randomUUID(), changed: false } }
    function draftForm (item) { return { id: item.id, title: item.title, description: item.description, tags: item.tags.join('，'), videoName: item.videoName, sourceEventIds: item.sources.map((s) => s.id), expectedVersion: item.version, changed: false } }
    function DraftPanel ({ active, epoch, seed, onSaved }) {
      const [resource, reload] = useOwnerDocument(DRAFTS_URL, active, epoch)
      const [form, setForm] = React.useState(freshDraft)
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [error, setError] = React.useState('')
      const [saved, setSaved] = React.useState(null)
      const change = (patch) => { setForm((old) => ({ ...old, ...patch, changed: true })); setNotice(''); setError('') }
      React.useEffect(() => {
        if (!seed) return
        setForm((old) => ({ ...old, title: old.title || seed.label.slice(0, 80), sourceEventIds: [...new Set([...old.sourceEventIds, seed.id])].slice(0, 5), changed: true }))
        setNotice('已关联这条生活记录，原有文字保留。')
      }, [seed])
      const open = (item) => { setSaved(item); setForm(draftForm(item)); setNotice(''); setError('') }
      const save = async (event) => {
        event.preventDefault()
        if (saving) return
        setSaving(true); setError(''); setNotice('')
        try {
          const payload = { ...form, tags: form.tags.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean) }
          if (!payload.id) delete payload.id
          delete payload.changed
          const result = await ownerRequest(DRAFTS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          open(result.item); setNotice('已保存到本机，尚未投稿。'); reload(); onSaved()
        } catch (err) { setError(err.message) } finally { setSaving(false) }
      }
      return h('section', { className: 'life-view', hidden: !active, 'aria-label': 'B站投稿草稿' },
        h('div', { className: 'life-panel-heading' }, h('div', null, h('h2', null, 'B 站投稿草稿'), h('p', null, '先把想说的整理好，再由你确认投稿。')), h('span', { className: 'life-status-badge' }, '本地草稿 · 待人工投稿')),
        h('div', { className: 'life-draft-layout' },
          h('aside', { className: 'life-card', 'aria-label': '草稿列表' },
            h('button', { className: 'life-button', type: 'button', disabled: saving || form.changed, title: form.changed ? '请先保存或放弃当前修改' : undefined, onClick: () => { setForm(freshDraft()); setSaved(null); setNotice(''); setError('') } }, '新草稿'),
            loadNotice(resource, reload), resource.data?.items.length ? h('ul', { className: 'life-draft-list' }, resource.data.items.map((item) => h('li', { key: item.id }, h('button', { type: 'button', className: 'life-draft-card' + (form.id === item.id ? ' selected' : ''), disabled: saving || form.changed, onClick: () => open(item) }, h('strong', null, item.title), h('small', null, when(item.updatedAt)), h('span', null, '待人工投稿'))))) : resource.status === 'ok' ? h('p', { className: 'life-empty' }, '还没有投稿草稿。') : null),
          h('form', { className: 'life-card life-draft-form', onSubmit: save, 'aria-label': '编辑投稿草稿', 'aria-busy': saving },
            h('label', { className: 'life-field' }, h('span', null, '标题'), h('input', { value: form.title, maxLength: 80, required: true, disabled: saving, placeholder: '给这段经历起一个标题', onChange: (e) => change({ title: e.target.value }) })),
            h('label', { className: 'life-field' }, h('span', null, '简介'), h('textarea', { value: form.description, maxLength: 4000, rows: 6, disabled: saving, placeholder: '发生了什么、试过什么、下一步准备怎么做…', onChange: (e) => change({ description: e.target.value }) })),
            h('label', { className: 'life-field' }, h('span', null, '标签'), h('input', { value: form.tags, disabled: saving, placeholder: '用逗号分隔，最多 10 个', onChange: (e) => change({ tags: e.target.value }) })),
            h('label', { className: 'life-field' }, h('span', null, '视频文件名（可选）'), h('input', { value: form.videoName, maxLength: 200, disabled: saving, placeholder: '例如：我的实验记录.mp4', onChange: (e) => change({ videoName: e.target.value }) }), h('small', null, '仅记录材料名称，不上传或附带视频。')),
            h('div', { className: 'life-source-note' }, form.sourceEventIds.length ? '已关联 ' + form.sourceEventIds.length + ' 条生活记录；导出时会附上来源。' : '尚未关联生活记录。可以从账本中选择素材，也可以自行核对事实。',
              form.sourceEventIds.length ? h('button', { className: 'life-link', type: 'button', disabled: saving, onClick: () => change({ sourceEventIds: [] }) }, '清除关联') : null),
            h('p', { className: 'life-muted' }, '导出清单包含 AI 生成标识和投稿前检查项。视频、封面和分区仍需你在 B 站核对。'),
            error ? h('p', { className: 'life-panel-error', role: 'alert' }, error) : null,
            notice ? h('p', { className: 'life-save-notice', role: 'status' }, notice) : null,
            h('div', { className: 'life-form-actions' }, h('button', { type: 'submit', className: 'life-button life-primary', disabled: saving || !form.title.trim() }, saving ? '保存中…' : '保存草稿'),
              h('a', { className: 'life-button', href: form.id && !form.changed ? EXPORT_URL + '?id=' + encodeURIComponent(form.id) : undefined, 'aria-disabled': !form.id || form.changed, download: true }, '导出投稿清单'),
              form.changed ? h('button', { type: 'button', className: 'life-link', disabled: saving, onClick: () => { setForm(saved ? draftForm(saved) : freshDraft()); setError(''); setNotice('已放弃未保存的修改。') } }, '放弃修改') : null),
            h('a', { className: 'life-link', href: 'https://member.bilibili.com/', target: '_blank', rel: 'noopener noreferrer' }, '打开 B 站创作中心（手动投稿）'))))
    }

    function LifeOverview ({ onChat, onCompose } = {}) {
      const [state, retry] = useLifeState()
      const [expanded, setExpanded] = React.useState(false)
      const [page, setPage] = React.useState('overview')
      const [epoch, refreshPages] = React.useState(0)
      const [draftSeed, setDraftSeed] = React.useState(null)
      const refresh = () => { retry(); refreshPages((n) => n + 1) }
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
        setPage('ledger')
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
          h('div', { className: 'life-actions' }, button('和它说话', 'chat', () => setPage('chat'), true),
            button('看它干了什么', 'ledger', today), button('照料', 'care', undefined, false, true)),
          h('dl', { className: 'life-strip' },
            cell('状态变量', '身份 v' + text(life.identity?.revision, '0'), interest ? '兴趣：' + interest.topic : '兴趣正在积累'),
            cell('今日预算', life.wake?.maxPerDay === null ? '尚未设置唤醒额度' : '已醒 ' + text(life.wakeCountToday, '0') + ' / ' + text(life.wake?.maxPerDay) + ' 次', '费用尚无记录'),
            cell('它答应过', life.openCommitments?.[0]?.what || '没有未完成的约定', life.openCommitments?.[0]?.dueAt ? when(life.openCommitments[0].dueAt) : '它会把约定记在这里'),
            cell('需要你', attention.total ? [attention.approval ? attention.approval + ' 条草稿待确认' : '', attention.unconfirmed ? attention.unconfirmed + ' 条发布结果待核对' : '', attention.manualDrafts ? attention.manualDrafts + ' 份 B 站草稿待处理' : ''].filter(Boolean).join('；') : '暂时没有需要你的事', null, attention.total > 0)),
          h('footer', { className: 'life-stamp' }, h('span', null, life.wake?.paused ? '自主唤醒已暂停' : life.wake?.enabled === false ? '自主唤醒已关闭' : '下次醒来：' + when(life.nextWakeAt)),
            h('span', null, '记录更新于 ' + time(life.generatedAt))))
      }
      return h('section', { id: 'life-overview', 'aria-label': '鱼缸' }, h('style', null, CSS),
        h('div', { className: 'life-app' },
          h('aside', { className: 'life-nav', 'aria-label': '鱼缸导航' },
            h('div', { className: 'life-id' }, h(Avatar, { className: 'life-avatar', name }),
              h('div', null, h('strong', null, name), h('div', { className: 'life-muted' }, 'lifeId ' + text(life?.identity?.lifeId)))),
            h('nav', { className: 'life-navlist' }, NAV.map(([id, glyph, label]) => h('button', {
              key: id, type: 'button', className: 'life-navi' + (id === page ? ' active' : ''),
              'aria-current': id === page ? 'page' : undefined,
              disabled: !['overview', 'ledger', 'chat', 'works'].includes(id),
              title: !['overview', 'ledger', 'chat', 'works'].includes(id) ? '暂不可用' : undefined,
              onClick: () => setPage(id),
            }, icon(glyph), label, id === 'works' && attention.manualDrafts > 0 ? h('span', { className: 'life-nav-badge' }, attention.manualDrafts) : null))),
            h('div', { className: 'life-navfoot' }, h('span', null, age ? '相伴第 ' + age + ' 天' : '等待第一段经历'),
              h('p', null, '它需要几天才有自己的生活。'))),
          h('main', { className: 'life-main' },
            h('header', { className: 'life-bar' }, h('h1', null, page === 'works' ? '作品与发布' : NAV.find(([id]) => id === page)?.[2] || '运行总览'),
              h('span', { className: 'life-axis' }, '生活', h('span', { className: 'life-live' }, living)),
              h('span', { className: 'life-axis' }, '系统', h('span', { className: state.status === 'error' ? 'life-warning' : 'life-good', title: '这里只确认生活记录可读取，模型与渠道状态尚未检查' }, state.status === 'error' ? '读取异常' : life ? '状态可读' : '检查中')),
              h('button', { type: 'button', className: 'life-icon', onClick: refresh, 'aria-label': '刷新近况', title: '刷新近况' }, icon('refresh')),
              h('button', { type: 'button', className: 'life-icon', disabled: true, 'aria-label': '暂停', title: '暂停功能暂不可用' }, icon('pause'))),
            page === 'overview' ? content : null,
            h(LedgerPanel, { active: page === 'ledger', epoch, onDraft: (event) => { setDraftSeed({ ...event }); setPage('works') } }),
            h(ChatPanel, { active: page === 'chat', life, onChat, onCompose }),
            h(DraftPanel, { active: page === 'works', epoch, seed: draftSeed, onSaved: retry }))))
    }

    const inject = ['slots', 'layout', 'uiWorkspace']
    function apply (ctx) {
      // Same keyed main + sidebar entry contract as dsh-client-ui-schedule.
      // A page belongs to the shell; an always-on fixed overlay obscures chat.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID,
        inject: () => ({ onChat: () => ctx.layout.selectPanel(null), onCompose: (prompt) => ctx.uiWorkspace.startSession(undefined, { prompt, clearPreviousDraft: false }) }),
      }, LifeOverview))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '鱼缸',
      }, ({ size = 16 }) => icon('fish', size)))
    }
    exports.name = 'dsh-life-ui'
    exports.inject = inject
    exports.apply = apply
    exports.LifeOverview = LifeOverview
    exports.chatPrompt = chatPrompt
    exports.ownerRequest = ownerRequest
    return module.exports
  },
})
