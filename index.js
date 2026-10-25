// DSH host plugin: show a Windows notification when a session turn finishes.
//
// Design notes:
// - Everything is registered through `ctx`: `ctx.on` for session events and
//   `ctx.effect` for timers/child processes, so unloading the plugin row tears
//   everything down.
// - No `@deepseek-ai/*` imports on purpose: a locally `link:`-installed plugin
//   only needs Node builtins, which keeps module resolution independent of the
//   DSH installation directory.
// - The notification itself is delivered by `notify.ps1` (Windows PowerShell
//   5.1, present on every Windows 11 install) because a portable Node process
//   cannot raise a native Windows toast by itself.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-session-notifier'

const LOG_PREFIX = '[dsh-session-notifier]'
const NOTIFIER_SCRIPT = fileURLToPath(new URL('./notify.ps1', import.meta.url))

const DEFAULT_CONFIG = Object.freeze({
  /** Master switch; `false` makes `apply` a no-op. */
  enabled: true,
  /** Which turn endings produce a notification. */
  notifyOn: 'completed-and-error', // 'completed' | 'completed-and-error' | 'all'
  /** Suppress the notification while a DSH window is in the foreground. */
  onlyWhenUnfocused: true,
  /** Play the system notification sound. */
  sound: true,
  /** Language of the built-in notification strings. */
  language: 'zh', // 'zh' | 'en'
  /** Coalescing window: a following `turn/start` cancels a pending toast. */
  debounceMs: 1200,
  /** Skip turns shorter than this (useful to filter tiny refactors). */
  minTurnDurationMs: 0,
  /** Also notify for subagent sessions; off by default to avoid toast storms. */
  notifySubagents: false,
  /** Process names that count as "DSH is focused" (case-insensitive). */
  dshProcessNames: ['DeepSeek Harness'],
  /** Delivery channel: 'auto' (toast, balloon on failure), 'toast' or 'balloon'. */
  mode: 'auto',
  /** Optional registered AppUserModelID used as the toast source label. */
  aumid: '',
  /** Optional UTF-8 diagnostic log written by notify.ps1 (empty = off). */
  logFile: '',
  /** Kill a hung notifier process after this many milliseconds. */
  timeoutMs: 20000,
  /** Test hook: log the payload instead of spawning PowerShell. */
  dryRun: false,
})

const TEXT = {
  zh: {
    appName: 'DeepSeek Harness',
    completed: 'DSH 会话完成',
    error: 'DSH 会话出错',
    aborted: 'DSH 会话已取消',
    blocked: 'DSH 会话已停止',
    'max-tokens': 'DSH 会话达到输出上限',
    unknown: 'DSH 会话结束',
    duration: (seconds) => `用时 ${seconds}`,
    canceled: '已取消',
    blockedDetail: '已停止',
    maxTokensDetail: '达到输出上限',
    turn: (turn) => `第 ${turn} 轮`,
  },
  en: {
    appName: 'DeepSeek Harness',
    completed: 'DSH session completed',
    error: 'DSH session failed',
    aborted: 'DSH session canceled',
    blocked: 'DSH session stopped',
    'max-tokens': 'DSH session hit the output limit',
    unknown: 'DSH session ended',
    duration: (seconds) => `took ${seconds}`,
    canceled: 'canceled',
    blockedDetail: 'stopped',
    maxTokensDetail: 'output limit reached',
    turn: (turn) => `turn ${turn}`,
  },
}

/** Resolve the Windows PowerShell 5.1 executable without relying on PATH. */
function resolvePowerShell() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

function readBoolean(raw, fallback) {
  return typeof raw === 'boolean' ? raw : fallback
}

function readNumber(raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(Math.max(raw, min), max)
}

function readString(raw, fallback) {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback
}

function readEnum(raw, allowed, fallback) {
  return typeof raw === 'string' && allowed.includes(raw) ? raw : fallback
}

function readStringArray(raw, fallback) {
  if (!Array.isArray(raw)) return fallback
  const values = raw.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
  return values.length > 0 ? values : fallback
}

/** Apply defaults and tolerate a partially invalid config instead of failing the row. */
function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const config = {
    enabled: readBoolean(input.enabled, DEFAULT_CONFIG.enabled),
    notifyOn: readEnum(input.notifyOn, ['completed', 'completed-and-error', 'all'], DEFAULT_CONFIG.notifyOn),
    onlyWhenUnfocused: readBoolean(input.onlyWhenUnfocused, DEFAULT_CONFIG.onlyWhenUnfocused),
    sound: readBoolean(input.sound, DEFAULT_CONFIG.sound),
    language: readEnum(input.language, ['zh', 'en'], DEFAULT_CONFIG.language),
    debounceMs: Math.round(readNumber(input.debounceMs, DEFAULT_CONFIG.debounceMs, { min: 0, max: 60000 })),
    minTurnDurationMs: Math.round(readNumber(input.minTurnDurationMs, DEFAULT_CONFIG.minTurnDurationMs, { min: 0 })),
    notifySubagents: readBoolean(input.notifySubagents, DEFAULT_CONFIG.notifySubagents),
    dshProcessNames: readStringArray(input.dshProcessNames, DEFAULT_CONFIG.dshProcessNames),
    mode: readEnum(input.mode, ['auto', 'toast', 'balloon'], DEFAULT_CONFIG.mode),
    aumid: readString(input.aumid, DEFAULT_CONFIG.aumid),
    logFile: readString(input.logFile, DEFAULT_CONFIG.logFile),
    timeoutMs: Math.round(readNumber(input.timeoutMs, DEFAULT_CONFIG.timeoutMs, { min: 1000, max: 120000 })),
    dryRun: readBoolean(input.dryRun, DEFAULT_CONFIG.dryRun),
  }
  config.appName = readString(input.appName, TEXT[config.language].appName)
  return config
}

function formatDuration(milliseconds, language) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000))
  if (language === 'en') {
    if (totalSeconds < 60) return `${totalSeconds}s`
    return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  }
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  return `${Math.floor(totalSeconds / 60)} 分 ${String(totalSeconds % 60).padStart(2, '0')} 秒`
}

function truncate(text, maxLength) {
  const value = String(text).replace(/\s+/gu, ' ').trim()
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

/** A readable label for the notification body: session title, then folder name. */
function sessionLabel(session, state) {
  if (typeof state.title === 'string' && state.title.trim().length > 0) {
    return truncate(state.title, 120)
  }
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    const folder = path.basename(cwd.replace(/[\\/]+$/u, ''))
    if (folder.length > 0) return truncate(folder, 120)
  }
  const id = typeof session?.id === 'string' ? session.id : ''
  return id.length > 0 ? truncate(id, 24) : 'DSH'
}

/**
 * The title provider appends `session/title` asynchronously; a short turn may
 * end before that event arrives. As a best-effort refresh at delivery time read
 * the optional `sessionTitle` service directly (no `inject`, so a profile
 * without the title plugin still loads).
 */
function refreshTitle(ctx, session, state) {
  try {
    const title = ctx.get?.('sessionTitle')?.get?.(session)?.title
    if (typeof title === 'string' && title.trim().length > 0) state.title = title.trim()
  } catch {
    // Optional service; keep the cached title.
  }
}

function shouldNotify(config, reasonKind) {
  if (reasonKind === 'completed') return true
  if (config.notifyOn === 'completed') return false
  if (config.notifyOn === 'completed-and-error') return reasonKind === 'error'
  return true
}

/**
 * Build the PowerShell payload for one finished turn.
 * The notifier script owns presentation details (toast vs. balloon, focus check).
 */
function buildPayload(config, session, state, event) {
  const text = TEXT[config.language] ?? TEXT.zh
  const reason = event?.data?.reason
  const reasonKind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
  const turn = event?.data?.turn
  const label = sessionLabel(session, state)
  const eventTime = typeof event?.time === 'number' ? event.time : Date.now()
  const duration = typeof state.startedAt === 'number' ? eventTime - state.startedAt : null

  const title = text[reasonKind] ?? text.unknown
  let detail = ''
  if (reasonKind === 'completed') {
    detail = duration !== null ? text.duration(formatDuration(duration, config.language)) : ''
  } else if (reasonKind === 'error') {
    const message = reason?.error?.message
    detail = typeof message === 'string' && message.length > 0 ? truncate(message, 140) : ''
  } else if (reasonKind === 'aborted') {
    detail = text.canceled
  } else if (reasonKind === 'blocked') {
    detail = text.blockedDetail
  } else if (reasonKind === 'max-tokens') {
    detail = text.maxTokensDetail
  }

  const bodyParts = [label]
  if (detail.length > 0) bodyParts.push(detail)
  if (typeof turn === 'number' && turn > 0) bodyParts.push(text.turn(turn))

  const payload = {
    title,
    body: bodyParts.join(' · '),
    appName: config.appName,
    sound: config.sound,
    onlyWhenUnfocused: config.onlyWhenUnfocused,
    focusProcessNames: config.dshProcessNames,
    mode: config.mode,
  }
  if (config.logFile.length > 0) payload.logFile = config.logFile
  if (config.aumid.length > 0) payload.aumid = config.aumid
  return payload
}

/**
 * Register the session notifier on a Cordis context.
 *
 * The plugin listens to `session/event`, tracks one small state record per
 * session id, and spawns `notify.ps1` after a short debounce. Everything it
 * creates is owned by `ctx`, so unloading the plugin row cleans up timers and
 * child processes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx host context
 * @param {object} [rawConfig] optional plugin configuration (see README)
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  if (process.platform !== 'win32') {
    console.warn(`${LOG_PREFIX} only supports Windows; plugin is inactive on ${process.platform}`)
    return
  }

  const powershell = resolvePowerShell()
  const sessions = new Map()
  const timers = new Set()
  const children = new Set()

  function stateFor(session) {
    const id = typeof session?.id === 'string' ? session.id : String(session)
    let state = sessions.get(id)
    if (state === undefined) {
      state = { startedAt: null, title: null, timer: null, lastEndedTurn: null }
      sessions.set(id, state)
    }
    return state
  }

  function clearTimer(state) {
    if (state?.timer !== null && state?.timer !== undefined) {
      clearTimeout(state.timer)
      timers.delete(state.timer)
      state.timer = null
    }
  }

  function resetState(session) {
    const id = typeof session?.id === 'string' ? session.id : String(session)
    const state = sessions.get(id)
    if (state === undefined) return
    clearTimer(state)
    sessions.delete(id)
  }

  function deliver(payload) {
    if (process.env.DSH_SESSION_NOTIFIER_DEBUG === '1') {
      console.error(`${LOG_PREFIX} deliver: ${JSON.stringify(payload)}`)
    }
    if (config.dryRun) {
      console.log(`${LOG_PREFIX} dry-run payload: ${JSON.stringify(payload)}`)
      return
    }
    let encoded
    try {
      encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    } catch (error) {
      console.warn(`${LOG_PREFIX} could not encode notification payload: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      NOTIFIER_SCRIPT,
      '-PayloadBase64',
      encoded,
    ]
    let child
    try {
      // Keep the child attached to DSH's process tree: on Windows a DETACHED
      // console process exits before running the script, so detached must stay
      // false. stdio is ignored and the child is unref'd, so it never blocks.
      child = spawn(powershell, args, { windowsHide: true, stdio: 'ignore', detached: false })
    } catch (error) {
      console.warn(`${LOG_PREFIX} could not start notifier: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    children.add(child)
    if (process.env.DSH_SESSION_NOTIFIER_DEBUG === '1') {
      console.error(`${LOG_PREFIX} spawned powershell pid=${child.pid} script=${NOTIFIER_SCRIPT}`)
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Process already gone.
      }
    }, config.timeoutMs)
    killTimer.unref?.()
    child.once('error', (error) => {
      clearTimeout(killTimer)
      children.delete(child)
      console.warn(`${LOG_PREFIX} notifier failed: ${error.message}`)
    })
    child.once('exit', (code) => {
      clearTimeout(killTimer)
      children.delete(child)
      if (code !== 0 && code !== null) {
        console.warn(`${LOG_PREFIX} notifier exited with code ${code}`)
      }
    })
    child.unref?.()
  }

  function scheduleNotification(session, state, event, reasonKind) {
    clearTimer(state)
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (state.timer !== timer) return
      state.timer = null
      if (!shouldNotify(config, reasonKind)) return
      refreshTitle(ctx, session, state)
      deliver(buildPayload(config, session, state, event))
    }, config.debounceMs)
    timers.add(timer)
    state.timer = timer
  }

  function handleTurnEnd(session, state, event) {
    const reason = event?.data?.reason
    const reasonKind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
    const turn = event?.data?.turn
    if (typeof turn === 'number' && state.lastEndedTurn === turn) return

    const isSubagent = session?.header?.origin === 'subagent' || (typeof session?.header?.parentSession === 'string' && session.header.parentSession.length > 0)
    if (isSubagent && !config.notifySubagents) return
    if (!shouldNotify(config, reasonKind)) return

    const eventTime = typeof event?.time === 'number' ? event.time : Date.now()
    if (typeof state.startedAt === 'number' && eventTime - state.startedAt < config.minTurnDurationMs) return

    state.lastEndedTurn = typeof turn === 'number' ? turn : null
    scheduleNotification(session, state, event, reasonKind)
  }

  function onSessionEvent(session, event) {
    try {
      if (event === null || typeof event !== 'object') return
      switch (event.type) {
        case 'turn/start': {
          const state = stateFor(session)
          clearTimer(state)
          state.startedAt = typeof event.time === 'number' ? event.time : Date.now()
          state.lastEndedTurn = null
          break
        }
        case 'turn/end': {
          handleTurnEnd(session, stateFor(session), event)
          break
        }
        case 'session/title': {
          const title = event.data?.title
          if (typeof title === 'string' && title.length > 0) stateFor(session).title = title
          break
        }
        default:
          break
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} failed to handle ${String(event?.type)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.on('session/event', onSessionEvent)
  ctx.on('session/disposed', (session) => resetState(session))

  ctx.effect(
    () => () => {
      for (const state of sessions.values()) clearTimer(state)
      sessions.clear()
      for (const child of children) {
        try {
          child.kill()
        } catch {
          // Process already gone.
        }
      }
      children.clear()
    },
    'dsh-session-notifier timers and notifier processes',
  )

  console.log(
    `${LOG_PREFIX} loaded (notifyOn=${config.notifyOn}, onlyWhenUnfocused=${config.onlyWhenUnfocused}, dryRun=${config.dryRun})`,
  )
}
