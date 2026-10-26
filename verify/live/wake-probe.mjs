/**
 * Wake-live probe — throwaway driver for verify/live/wake-live.mjs. Never shipped.
 *
 * The `web` profile serves HTTP; it has no command that "runs one turn". So the
 * only unattended way to get a Session (and therefore something for `schedule`
 * to wake) is a plugin mounted through `dsh web --patch`. This file is that
 * plugin. It is driven by environment variables, one mode per process:
 *
 *   arm     create a preset-free Session, arm a one-shot wake, exit at once.
 *           The schedule service persists the task, so the Host may then die.
 *   watch   a *second* process: report the delivery dsh performs on startup for
 *           a task that came due while the Host was down, plus the ledger row.
 *   replay  a *third* process: read the persisted Session prefix back and find
 *           the same schedule message by id. Never activates an Agent.
 *
 * Every mode writes a JSON result file, so the runner never parses human prose.
 */
import fs from 'node:fs'

export const name = 'dsh-life-wake-live-probe'
export const inject = []

const MODE = process.env.WAKE_LIVE_MODE || ''
const STATE = process.env.WAKE_LIVE_STATE || ''
const RESULT = process.env.WAKE_LIVE_RESULT || ''
const AFTER = Number(process.env.WAKE_LIVE_AFTER_SECONDS || 25)
const CWD = process.env.WAKE_LIVE_CWD || process.cwd()

const t0 = Date.now()
const now = () => new Date().toISOString()
const say = (kind, extra = {}) =>
  console.log(JSON.stringify({ at: now(), tRelMs: Date.now() - t0, mode: MODE, kind, ...extra }))
const messageOf = (err) => String(err && err.message ? err.message : err)
const errInfo = (err) => ({ message: messageOf(err), code: err && err.code ? String(err.code) : null })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let exited = false
function finish (code, why) {
  if (exited) return
  exited = true
  say('exit', { code, why })
  // Give stdout a tick to flush, then leave: boot must not hang the suite.
  setTimeout(() => process.exit(code), 250)
}

function readJson (file, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson (file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function apply (root) {
  root.inject(['schedule', 'sessionController', 'connection', 'typertGateway'], async (ctx) => {
    const services = {
      schedule: Boolean(ctx.schedule),
      sessionController: Boolean(ctx.sessionController),
      connection: Boolean(ctx.connection),
      typertGateway: Boolean(ctx.typertGateway),
    }
    say('services-ready', services)

    // ---- arm -----------------------------------------------------------------
    if (MODE === 'arm') {
      if (!services.schedule || !services.sessionController || !services.connection || !services.typertGateway) {
        writeJson(RESULT, { ok: false, reason: 'service-missing', services })
        return finish(6, 'service-missing')
      }
      await sleep(4_000) // let the profile finish composing before the first create
      try {
        // A Session is created through a Peer, not through the bare service: the
        // preset/binding machinery needs the Peer's scope. Direct service calls
        // fail with `agent-preset/invalid` for an unrelated reason (see patch).
        const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
        const created = await ctx.typertGateway.dispatchRpc(
          'session/create',
          { args: { request: { cwd: CWD } } },
          new AbortController().signal,
          peer,
        )
        const sessionId = created && created.ok && created.value ? created.value.sessionId : undefined
        if (!sessionId) {
          writeJson(RESULT, { ok: false, reason: 'create-failed', services, response: created })
          return finish(7, 'create-failed')
        }
        const record = await ctx.schedule.create(sessionId, {
          title: 'wake-live-probe',
          prompt: 'WAKE_LIVE_MARKER: a scheduled wake; no human spoke.',
          after_seconds: AFTER,
        })
        writeJson(STATE, {
          sessionId,
          scheduleId: record.id,
          scheduledAt: record.scheduledAt,
          afterSeconds: AFTER,
          armedAt: now(),
          services,
        })
        say('armed', { sessionId, scheduleId: record.id, scheduledAt: record.scheduledAt })
        return finish(0, 'armed-and-leaving')
      } catch (err) {
        writeJson(RESULT, { ok: false, reason: 'arm-failed', services, error: errInfo(err) })
        return finish(8, 'arm-failed')
      }
    }

    // ---- watch ---------------------------------------------------------------
    if (MODE === 'watch') {
      const state = readJson(STATE, {})
      say('watching', { sessionId: state.sessionId ?? null, scheduleId: state.scheduleId ?? null })

      const result = {
        ok: false,
        reason: 'no-delivery',
        sessionId: state.sessionId ?? null,
        scheduleId: state.scheduleId ?? null,
        scheduledAt: state.scheduledAt ?? null,
        messageId: null,
        sourceKind: null,
        textHead: null,
        turnStarted: false,
        history: null,
        deliveredAtSeenAt: null,
      }

      let settled = false
      const settle = (reason) => {
        if (settled) return
        settled = true
        result.reason = reason
        writeJson(RESULT, result)
        finish(result.ok ? 0 : 3, reason)
      }

      ctx.on('session/event', (session, event) => {
        const data = event && typeof event.data === 'object' && event.data !== null ? event.data : {}
        if (event.type === 'turn/start') result.turnStarted = true
        if (event.type !== 'user/message') return
        const source = data.source ?? {}
        if (source.kind !== 'schedule') return
        result.messageId = data.id ?? null
        result.sourceKind = source.kind
        result.textHead = Array.isArray(data.content) && data.content[0] && typeof data.content[0].text === 'string'
          ? data.content[0].text.slice(0, 60)
          : null
        say('wake-message', { messageId: result.messageId, textHead: result.textHead })
        void collectHistory(600)
      })

      // The ledger row is written after the message is durable; poll briefly.
      async function collectHistory (tries) {
        for (let i = 0; i < tries && !settled; i++) {
          try {
            const history = await ctx.schedule.history({
              sessionId: result.sessionId,
              id: result.scheduleId,
              limit: 10,
            })
            const records = Array.isArray(history && history.records) ? history.records : []
            const hit = records.find((r) => r && r.messageId === result.messageId) || records[0]
            if (hit && hit.deliveredAt) {
              result.history = {
                scheduledAt: hit.scheduledAt ?? null,
                deliveredAt: hit.deliveredAt,
                messageId: hit.messageId ?? null,
              }
              result.deliveredAtSeenAt = now()
              result.ok = true
              say('ledger-row', result.history)
              return settle('delivered')
            }
          } catch (err) {
            result.historyError = errInfo(err)
          }
          await sleep(500)
        }
        if (!settled) {
          result.ok = Boolean(result.messageId)
          settle(result.ok ? 'delivered-without-ledger' : 'no-delivery')
        }
      }

      setTimeout(() => settle('timeout'), 120_000)
      return
    }

    // ---- replay --------------------------------------------------------------
    if (MODE === 'replay') {
      const state = readJson(STATE, {})
      await sleep(1_500)
      try {
        // Persistence read only: inspect() must not activate an Agent.
        const inspected = await ctx.sessionController.inspect(state.sessionId)
        const events = Array.isArray(inspected.events) ? inspected.events : []
        const hits = events.filter((e) =>
          e && e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'schedule')
        writeJson(RESULT, {
          ok: true,
          sessionId: state.sessionId ?? null,
          eventCount: events.length,
          hits: hits.length,
          messageIds: hits.map((e) => e.data.id).filter(Boolean),
          tailTypes: events.slice(-12).map((e) => e.type),
        })
        say('replayed', { eventCount: events.length, hits: hits.length })
        return finish(0, 'replay-done')
      } catch (err) {
        writeJson(RESULT, { ok: false, reason: 'inspect-failed', error: errInfo(err) })
        return finish(9, 'inspect-failed')
      }
    }

    finish(10, `unknown-mode:${MODE}`)
  })
}

export default { name, inject, apply }
