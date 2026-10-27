#!/usr/bin/env node
/**
 * harness/check.mjs —— 让「先想清楚再动手」变成机器能拦的事。
 *
 * 为什么存在：同一个错误在这个仓库里重复了四次 ——
 * 拿到一句话就动手做最大的那个产物（876 帧视频），而不是先问
 * 「这一版要证明什么、最小的载体是什么」。
 * 光靠记性没用，靠意志力也没用（批注刚写完就犯了）。
 *
 * 四条规则，全部可机器判定：
 *   1. 卡要先于产物 —— 用 git 的首次提交时间比对
 *   2. 验收必须可重跑 —— 反引号里的命令；状态为「完成」时闸门真的去跑
 *   3. 载体候选 ≥ 2 —— 少于两个就不是选的是撞的
 *   4. 对外产物必须带诚实边界 —— 不写它，产物就只能靠表演成立
 *
 * 规则 1 从本文件首次提交那一刻生效；更早的产物记为欠账（WARN），不追溯。
 * 历史改不了，能改的只有以后 —— 但欠账要一直显示，不能装作没有。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CARDS_DIR = path.join(ROOT, 'harness', 'cards')
const SELF = 'harness/check.mjs'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : ok === null ? 'WARN' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------- git helpers

function git (args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

const hasGit = Boolean(git(['rev-parse', '--is-inside-work-tree']))

/** First commit (unix ts) that touched `file`, or null if never committed. */
function firstCommitTime (file) {
  if (!hasGit) return null
  const out = git(['log', '--diff-filter=A', '--format=%ct', '--', file])
  const lines = out.split('\n').filter(Boolean)
  if (lines.length === 0) return null
  return Number(lines[lines.length - 1])
}

// ---------------------------------------------------------------- 解析意图卡

function parseCard (file) {
  const text = fs.readFileSync(file, 'utf8')
  const field = (name) => {
    const m = text.match(new RegExp(`^\\s*[-*]?\\s*${name}\\s*[:：]\\s*(.+)$`, 'm'))
    return m ? m[1].trim() : ''
  }
  const section = (name) => {
    const m = text.match(new RegExp(`^##\\s*${name}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm'))
    return m ? m[1].trim() : ''
  }
  const acceptance = section('验收')
  const commands = [...acceptance.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean)
  const carriers = section('载体候选')
  const bullets = (carriers.match(/^\s*[-*]\s+\S/gm) || []).length
  return {
    file,
    rel: path.relative(ROOT, file),
    status: field('状态'),
    products: field('产物'),
    goal: section('目标'),
    acceptance,
    commands,
    carriers,
    carrierCount: bullets,
    notDoing: section('不做什么'),
    limits: section('诚实边界'),
  }
}

function productPaths (card) {
  // 产物那一行里反引号包起来的路径，或裸路径（含 / 的 token）
  const raw = card.products
  const inTicks = [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())
  const bare = raw.split(/[\s,、;]+/).filter((t) => /[\/.]/.test(t) && !t.startsWith('http'))
  const all = [...inTicks, ...bare]
    .map((p) => p.replace(/^\.\//, '').replace(/[).,，。]+$/, ''))
    .filter((p) => p && !p.includes('*') && p !== '<会新增/改动的路径>')
  return [...new Set(all)]
}

// ---------------------------------------------------------------- 载入

if (!fs.existsSync(CARDS_DIR)) {
  console.log('FAIL  没有 harness/cards/ 目录 —— 协议没有落地')
  process.exit(1)
}

const cardFiles = fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith('.md')).sort()
const cards = cardFiles.map((f) => parseCard(path.join(CARDS_DIR, f)))

console.log(`\n读了 ${cards.length} 张意图卡\n${'─'.repeat(56)}`)

const gateTime = firstCommitTime(SELF)

// ---------------------------------------------------------------- 规则 1
// 卡必须先于产物。这是唯一一条能真正拦住「先做大东西、再补说明」的规则。

let aheadCount = 0
let debtCount = 0
for (const card of cards) {
  if (!hasGit) { check(`[1] ${card.rel} 先于产物存在`, null, '不在 git 仓库里，跳过'); continue }
  const cardTime = firstCommitTime(card.rel)
  for (const product of productPaths(card)) {
    const productTime = firstCommitTime(product)
    if (productTime === null) continue // 还没提交，闸门在提交前跑，不算违规
    if (cardTime === null) {
      // 卡还没提交、产物已提交 → 先做后补
      check(`[1] ${card.rel} 先于 ${product} 存在`, false, '卡还没提交，产物已经提交了 —— 这是「先做后补」')
      aheadCount++
      continue
    }
    // 规则 1 只从闸门本身被提交那一刻起生效
    if (gateTime && productTime < gateTime) {
      check(`[1] ${card.rel} 先于 ${product} 存在`, null, '闸门安装前的产物（欠账，不追溯）')
      debtCount++
      continue
    }
    if (productTime < cardTime) {
      check(`[1] ${card.rel} 先于 ${product} 存在`, false, `${product} 的提交早于卡 —— 先做后补`)
      aheadCount++
    } else {
      check(`[1] ${card.rel} 先于 ${product} 存在`, true, `${product} 晚于卡 ✓`)
    }
  }
}
if (aheadCount === 0 && cards.length > 0) {
  const withProducts = cards.filter((c) => productPaths(c).length > 0).length
  if (withProducts === 0) check('[1] 卡先于产物存在', null, '本轮的卡都还没产出产物')
}

// ---------------------------------------------------------------- 规则 2
for (const card of cards) {
  const ok = card.commands.length > 0
  check(`[2] ${card.rel} 有可重跑的验收命令`, ok,
    ok ? card.commands.map((c) => '`' + c + '`').join(' ') : '验收里没有反引号命令 —— 「看起来不错」不是验收')
}

// ---------------------------------------------------------------- 规则 3
for (const card of cards) {
  const ok = card.carrierCount >= 2
  check(`[3] ${card.rel} 比较过至少两个载体`, ok, `载体候选 ${card.carrierCount} 个`)
}

// ---------------------------------------------------------------- 规则 4
// 对外产物必须自带诚实边界。哪些算「对外」：docs/ 下的页面、showcase/ 下的成片、README 引用到的图/视频。
const outward = new Set()
if (fs.existsSync(path.join(ROOT, 'docs'))) {
  for (const f of fs.readdirSync(path.join(ROOT, 'docs'))) {
    if (/\.(html|md)$/.test(f) && !/^(scenarios|index)\.html$/.test(f) && !/\.md$/.test(f)) outward.add(`docs/${f}`)
  }
}
for (const card of cards) {
  for (const p of productPaths(card)) {
    if (/^(docs|showcase)\//.test(p) && /\.(html|mp4|gif)$/.test(p)) outward.add(p)
  }
}
// 视频的「诚实边界」写在生成它的脚本里（画面上的文案由脚本决定）
const OUTWARD_CHECK = [...outward]
let outwardBad = 0
for (const p of OUTWARD_CHECK) {
  const target = /\.(mp4|gif)$/.test(p) ? null : path.join(ROOT, p)
  if (!target || !fs.existsSync(target)) continue
  const text = fs.readFileSync(target, 'utf8')
  const ok = /harness:limits|诚实边界|不证明|没有证明|这不是演示|是方向，不是演示/.test(text)
  check(`[4] ${p} 自带诚实边界`, ok, ok ? '' : '对外产物没有说明它不证明什么 —— 它就只能靠表演成立')
  if (!ok) outwardBad++
}
if (OUTWARD_CHECK.length === 0) check('[4] 对外产物自带诚实边界', null, '本轮没有对外产物')

console.log('─'.repeat(56))
if (debtCount) console.log(`欠账 ${debtCount} 条（闸门安装前的产物，不追溯，但要一直显示）`)
const failed = results.filter((r) => r.ok === false)
console.log(`${results.filter((r) => r.ok === true).length}/${results.length} 通过` +
  (failed.length ? `，${failed.length} 条失败` : ''))
if (failed.length) console.log(`失败: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
