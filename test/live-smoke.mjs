// Manual smoke test: sends a REAL Windows notification through the plugin code
// path (fake Cordis context + synthetic session events -> notify.ps1).
//
// Run: node plugins/dsh-session-toast/test/live-smoke.mjs
// It pops one toast. If the DSH window has focus, the default onlyWhenUnfocused
// would suppress it, so this harness pins onlyWhenUnfocused:false.
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

if (process.platform !== 'win32') {
  console.error(`SKIP: dsh-session-toast is Windows-only (running on ${process.platform})`)
  process.exit(0)
}

const LOG_FILE = join(tmpdir(), 'dsh-session-toast-live.log')

const listeners = new Map()
const disposers = []
const ctx = {
  on(eventName, listener) {
    let bucket = listeners.get(eventName)
    if (bucket === undefined) {
      bucket = new Set()
      listeners.set(eventName, bucket)
    }
    bucket.add(listener)
    return () => bucket.delete(listener)
  },
  effect(factory) {
    const disposer = factory()
    if (typeof disposer === 'function') disposers.push(disposer)
  },
  emit(eventName, ...args) {
    for (const listener of [...(listeners.get(eventName) ?? [])]) listener(...args)
  },
}

apply(ctx, {
  dryRun: false,
  onlyWhenUnfocused: false,
  sound: true,
  language: 'zh',
  debounceMs: 0,
  logFile: LOG_FILE,
})

const session = {
  id: 'session-live-smoke',
  header: { cwd: process.cwd(), origin: 'user' },
}
const base = Date.now()
ctx.emit('session/event', session, { type: 'turn/start', time: base, data: { turn: 1 } })
ctx.emit('session/event', session, { type: 'session/title', time: base + 100, data: { title: '通知插件联调测试' } })
ctx.emit('session/event', session, {
  type: 'turn/end',
  time: base + 12_000,
  data: { turn: 1, reason: { kind: 'completed' } },
})

// Give PowerShell time to start the toast, then tear the plugin down.
setTimeout(() => {
  for (const disposer of disposers.splice(0).reverse()) disposer()
  console.log(`[live-smoke] sent; notifier log: ${LOG_FILE}`)
  console.log('[live-smoke] expected toast: "DSH 会话完成 · 通知插件联调测试 · 用时 12 秒 · 第 1 轮"')
}, 2_500)
