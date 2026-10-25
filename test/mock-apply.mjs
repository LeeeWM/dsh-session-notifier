// Offline harness: exercise `apply()` with a mock Cordis context and synthetic
// session events. This verifies registration, config handling, debounce,
// subagent filtering, duplicate suppression, and teardown without a DSH host
// and without actually showing Windows notifications (`dryRun: true`).
//
// Run: node plugins/dsh-session-notifier/test/mock-apply.mjs
import assert from 'node:assert/strict'
import { apply, name } from '../index.js'

if (process.platform !== 'win32') {
  console.log(`SKIP: dsh-session-notifier is Windows-only (running on ${process.platform})`)
  process.exit(0)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createMockCtx() {
  const listeners = new Map()
  const effects = []
  return {
    on(eventName, listener) {
      let bucket = listeners.get(eventName)
      if (bucket === undefined) {
        bucket = new Set()
        listeners.set(eventName, bucket)
      }
      bucket.add(listener)
      return () => bucket.delete(listener)
    },
    emit(eventName, ...args) {
      for (const listener of [...(listeners.get(eventName) ?? [])]) listener(...args)
    },
    effect(factory, _label) {
      const disposer = factory()
      if (typeof disposer === 'function') effects.push(disposer)
    },
    dispose() {
      for (const disposer of effects.splice(0).reverse()) disposer()
      listeners.clear()
    },
    listenerCount(eventName) {
      return listeners.get(eventName)?.size ?? 0
    },
  }
}

function captureConsole() {
  const lines = []
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = (...args) => lines.push({ level: 'log', text: args.join(' ') })
  console.warn = (...args) => lines.push({ level: 'warn', text: args.join(' ') })
  return {
    lines,
    restore() {
      console.log = originalLog
      console.warn = originalWarn
    },
    payloads() {
      return lines
        .filter((line) => line.text.includes('dry-run payload:'))
        .map((line) => JSON.parse(line.text.slice(line.text.indexOf('dry-run payload:') + 'dry-run payload:'.length)))
    },
  }
}

const SESSION = {
  id: 'session-test-0001',
  header: { cwd: 'C:\\Users\\Lenovo\\Desktop\\提问\\dsh-plugin-workspace', origin: 'user' },
}
const SUBAGENT = {
  id: 'session-test-sub',
  header: { cwd: 'C:\\Users\\Lenovo\\Desktop\\提问\\dsh-plugin-workspace', origin: 'subagent', parentSession: SESSION.id },
}

const tests = []
function test(title, run) {
  tests.push({ title, run })
}

test('exports a DSH row name and registers session listeners', async () => {
  assert.equal(typeof name, 'string')
  assert.ok(name.length > 0)
  const ctx = createMockCtx()
  apply(ctx, { dryRun: true })
  assert.equal(ctx.listenerCount('session/event'), 1)
  assert.equal(ctx.listenerCount('session/disposed'), 1)
  ctx.dispose()
})

test('disabled config registers nothing', async () => {
  const ctx = createMockCtx()
  apply(ctx, { enabled: false, dryRun: true })
  assert.equal(ctx.listenerCount('session/event'), 0)
  ctx.dispose()
})

test('completed turn produces one payload with title, duration and turn number', async () => {
  const consoleCapture = captureConsole()
  const ctx = createMockCtx()
  try {
    apply(ctx, { dryRun: true, debounceMs: 30, onlyWhenUnfocused: false, sound: false })
    const base = Date.now()
    ctx.emit('session/event', SESSION, { type: 'turn/start', seq: 1, time: base, data: { turn: 1 } })
    ctx.emit('session/event', SESSION, { type: 'session/title', seq: 2, time: base + 100, data: { title: '通知插件测试' } })
    ctx.emit('session/event', SESSION, { type: 'turn/end', seq: 3, time: base + 42_000, data: { turn: 1, reason: { kind: 'completed' } } })
    await sleep(120)
    const payloads = consoleCapture.payloads()
    assert.equal(payloads.length, 1)
    const payload = payloads[0]
    assert.equal(payload.title, 'DSH 会话完成')
    assert.match(payload.body, /通知插件测试/)
    assert.match(payload.body, /用时 42 秒/)
    assert.match(payload.body, /第 1 轮/)
    assert.equal(payload.onlyWhenUnfocused, false)
    assert.equal(payload.sound, false)
  } finally {
    consoleCapture.restore()
    ctx.dispose()
  }
})

test('debounce cancels a pending toast when the next turn starts (goal continuation)', async () => {
  const consoleCapture = captureConsole()
  const ctx = createMockCtx()
  try {
    apply(ctx, { dryRun: true, debounceMs: 40 })
    const base = Date.now()
    ctx.emit('session/event', SESSION, { type: 'turn/start', time: base, data: { turn: 1 } })
    ctx.emit('session/event', SESSION, { type: 'turn/end', time: base + 10_000, data: { turn: 1, reason: { kind: 'completed' } } })
    await sleep(10)
    ctx.emit('session/event', SESSION, { type: 'turn/start', time: base + 10_100, data: { turn: 2 } })
    await sleep(120)
    assert.equal(consoleCapture.payloads().length, 0)
  } finally {
    consoleCapture.restore()
    ctx.dispose()
  }
})

test('subagent turns are ignored by default, and included when notifySubagents is true', async () => {
  const consoleCapture = captureConsole()
  const ctx = createMockCtx()
  try {
    apply(ctx, { dryRun: true, debounceMs: 20 })
    const base = Date.now()
    ctx.emit('session/event', SUBAGENT, { type: 'turn/start', time: base, data: { turn: 1 } })
    ctx.emit('session/event', SUBAGENT, { type: 'turn/end', time: base + 5_000, data: { turn: 1, reason: { kind: 'completed' } } })
    await sleep(80)
    assert.equal(consoleCapture.payloads().length, 0)
  } finally {
    consoleCapture.restore()
    ctx.dispose()
  }

  const consoleCapture2 = captureConsole()
  const ctx2 = createMockCtx()
  try {
    apply(ctx2, { dryRun: true, debounceMs: 20, notifySubagents: true })
    const base = Date.now()
    ctx2.emit('session/event', SUBAGENT, { type: 'turn/start', time: base, data: { turn: 1 } })
    ctx2.emit('session/event', SUBAGENT, { type: 'turn/end', time: base + 5_000, data: { turn: 1, reason: { kind: 'completed' } } })
    await sleep(80)
    assert.equal(consoleCapture2.payloads().length, 1)
  } finally {
    consoleCapture2.restore()
    ctx2.dispose()
  }
})

test('notifyOn completed ignores failures; notifyOn all reports aborted turns', async () => {
  const consoleCapture = captureConsole()
  const ctx = createMockCtx()
  try {
    apply(ctx, { dryRun: true, debounceMs: 20, notifyOn: 'completed' })
    const base = Date.now()
    ctx.emit('session/event', SESSION, { type: 'turn/start', time: base, data: { turn: 1 } })
    ctx.emit('session/event', SESSION, { type: 'turn/end', time: base + 1_000, data: { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'boom' } } } })
    ctx.emit('session/event', SESSION, { type: 'turn/start', time: base + 2_000, data: { turn: 2 } })
    ctx.emit('session/event', SESSION, { type: 'turn/end', time: base + 3_000, data: { turn: 2, reason: { kind: 'aborted' } } })
    await sleep(80)
    assert.equal(consoleCapture.payloads().length, 0)
  } finally {
    consoleCapture.restore()
    ctx.dispose()
  }

  const consoleCapture2 = captureConsole()
  const ctx2 = createMockCtx()
  try {
    apply(ctx2, { dryRun: true, debounceMs: 20, notifyOn: 'all', language: 'en' })
    const base = Date.now()
    ctx2.emit('session/event', SESSION, { type: 'turn/start', time: base, data: { turn: 1 } })
    ctx2.emit('session/event', SESSION, { type: 'turn/end', time: base + 3_000, data: { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'boom' } } } })
    await sleep(80)
    const payloads = consoleCapture2.payloads()
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0].title, 'DSH session failed')
    assert.match(payloads[0].body, /boom/)
  } finally {
    consoleCapture2.restore()
    ctx2.dispose()
  }
})

test('duplicate turn/end for the same turn notifies once', async () => {
  const consoleCapture = captureConsole()
  const ctx = createMockCtx()
  try {
    apply(ctx, { dryRun: true, debounceMs: 20 })
    const base = Date.now()
    ctx.emit('session/event', SESSION, { type: 'turn/start', time: base, data: { turn: 1 } })
    ctx.emit('session/event', SESSION, { type: 'turn/end', time: base + 5_000, data: { turn: 1, reason: { kind: 'completed' } } })
    ctx.emit('session/event', SESSION, { type: 'turn/end', time: base + 5_100, data: { turn: 1, reason: { kind: 'completed' } } })
    await sleep(100)
    assert.equal(consoleCapture.payloads().length, 1)
  } finally {
    consoleCapture.restore()
    ctx.dispose()
  }
})

test('fallback label uses the working-directory folder when no title exists', async () => {
  const consoleCapture = captureConsole()
  const ctx = createMockCtx()
  try {
    apply(ctx, { dryRun: true, debounceMs: 20, language: 'en' })
    const base = Date.now()
    ctx.emit('session/event', SESSION, { type: 'turn/start', time: base, data: { turn: 3 } })
    ctx.emit('session/event', SESSION, { type: 'turn/end', time: base + 2_000, data: { turn: 3, reason: { kind: 'completed' } } })
    await sleep(80)
    const payload = consoleCapture.payloads()[0]
    assert.match(payload.body, /dsh-plugin-workspace/)
    assert.match(payload.body, /took 2s/)
  } finally {
    consoleCapture.restore()
    ctx.dispose()
  }
})

test('delivery refreshes an asynchronously generated title from sessionTitle', async () => {
  const consoleCapture = captureConsole()
  const ctx = createMockCtx()
  ctx.get = (name) => (name === 'sessionTitle' ? { get: () => ({ title: '服务里刷新到的标题' }) } : undefined)
  try {
    apply(ctx, { dryRun: true, debounceMs: 20 })
    const base = Date.now()
    ctx.emit('session/event', SESSION, { type: 'turn/start', time: base, data: { turn: 1 } })
    ctx.emit('session/event', SESSION, { type: 'turn/end', time: base + 1_000, data: { turn: 1, reason: { kind: 'completed' } } })
    await sleep(80)
    const payloads = consoleCapture.payloads()
    assert.equal(payloads.length, 1)
    assert.match(payloads[0].body, /服务里刷新到的标题/)
  } finally {
    consoleCapture.restore()
    ctx.dispose()
  }
})

test('dispose clears pending timers (no notification after unload)', async () => {
  const consoleCapture = captureConsole()
  const ctx = createMockCtx()
  try {
    apply(ctx, { dryRun: true, debounceMs: 60 })
    const base = Date.now()
    ctx.emit('session/event', SESSION, { type: 'turn/start', time: base, data: { turn: 1 } })
    ctx.emit('session/event', SESSION, { type: 'turn/end', time: base + 1_000, data: { turn: 1, reason: { kind: 'completed' } } })
    ctx.dispose()
    await sleep(150)
    assert.equal(consoleCapture.payloads().length, 0)
  } finally {
    consoleCapture.restore()
  }
})

const failures = []
for (const { title, run } of tests) {
  try {
    await run()
    console.log(`PASS  ${title}`)
  } catch (error) {
    failures.push({ title, error })
    console.error(`FAIL  ${title}\n${error?.stack ?? error}`)
  }
}

console.log(`\n${tests.length - failures.length}/${tests.length} mock-apply checks passed`)
if (failures.length > 0) process.exitCode = 1
