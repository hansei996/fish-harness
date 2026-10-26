/**
 * Verification probe (never shipped).
 *
 * Mounts beside dsh-life in a real dsh profile and captures what the model
 * would actually receive: the assembled system-prompt sections and the
 * model-facing tool schemas. This proves the life layer reaches the real
 * prompt/tool assembly rather than a test double.
 */
import fs from 'node:fs'

export const name = 'dsh-life-verify-probe'
export const inject = []

const OUT = process.env.LIFE_PROBE_OUT || '/tmp/dsh-life-probe.json'

export function apply (root) {
  const captured = { sections: [], tools: [], requestTools: [], at: new Date().toISOString() }
  let toolsCtx = null

  const flush = () => {
    try {
      fs.writeFileSync(OUT, `${JSON.stringify(captured, null, 2)}\n`, 'utf8')
    } catch (err) {}
  }

  root.inject(['tools'], (ctx) => { toolsCtx = ctx })

  root.inject(['systemPrompt'], (ctx) => {
    try {
      // The assembly event fires per turn, after every provider is registered,
      // so it is the correct place to observe the finished prompt and toolbox.
      root.on('system-prompt/assemble', (assembly) => {
        try {
          const sections = (assembly && assembly.sections) || []
          captured.sections = sections.map((s) => ({ name: s.name, text: String(s.text || '') }))
        } catch (err) {}
        try {
          const schemas = toolsCtx && typeof toolsCtx.tools.schemas === 'function' ? toolsCtx.tools.schemas() : []
          captured.tools = (Array.isArray(schemas) ? schemas : []).map((t) => ({ name: t && t.name, description: t && t.description }))
        } catch (err) { captured.toolsError = String(err && err.message) }
        return assembly
      })
    } catch (err) {}
  })

  process.on('exit', flush)
  root.effect(() => () => flush())
}

export default { name, inject, apply }
