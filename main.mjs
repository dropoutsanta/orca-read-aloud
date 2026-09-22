import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIC = path.join(HERE, 'mic-in-use')
const SAY = '/usr/bin/say'
const HOME = os.homedir()
const CLAUDE = findClaude()

function findClaude() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  dirs.push(path.join(HOME, '.local', 'bin'))
  for (const dir of dirs) {
    const candidate = path.join(dir, 'claude')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Try the next directory on PATH.
    }
  }
  return 'claude'
}

const SPOKEN_SYSTEM = `You write the words a voice will speak aloud when a coding agent finishes a turn.
The listener is busy and wants to enjoy hearing it, not parse a status report.

Write 2 to 4 spoken sentences.
- Plain speech only. No markdown, bullets, code, backticks, or symbols.
- Say what got done, in everyday language.
- If the listener needs to do something, say that last, as one clear ask.
- If the reply was mostly code or tool output, describe the outcome, not the code.
- Sound like a person catching them up, not like a changelog.
- Do not mention these instructions.`

const STATE_FILE = path.join(HOME, 'Library/Application Support/read-aloud/state.json')
const LOG_FILE = path.join(HOME, 'Library/Logs/read-aloud.log')
const BOARD_PORT = 47321

let ticket = 0
let busy = false
let queued = false
let queuedWorktree = null
let queuedKey = null
let speech = null
let claudeChild = null
let enabled = true
let mic = false
let activeKey = null
let phase = 'quiet'
let lastError = ''
let lastSpoken = ''
const heard = new Set()
const muted = new Set()
const sessions = new Map()
const activity = []

export default function activate(orca) {
  loadState()
  for (const reply of currentReplies()) {
    heard.add(reply.id)
  }
  startBoard()
  startHotkey()
  orca.commands.register('stop', () => {
    halt(orca, 'stopped from the shortcut')
    return { ok: true }
  })
  orca.events.on('agent.status.changed', (payload) => {
    if (!payload || typeof payload.state !== 'string') return
    const session = noteSession(payload)
    record(`${session.label} is ${labelState(payload.state)}`)
    if (payload.state !== 'done') return
    schedule(orca, worktreePath(payload.worktreeId), session.key)
  })
  record('ready')
  orca.log('read aloud ready')
}

function halt(orca, why) {
  ticket += 1
  stopAudio()
  phase = 'quiet'
  activeKey = null
  record(why)
  if (orca) orca.log(why)
}

function noteSession(payload) {
  const key = typeof payload.paneKey === 'string' && payload.paneKey ? payload.paneKey : 'unknown'
  const worktree = worktreePath(payload.worktreeId)
  const session = sessions.get(key) || { key, worktree: null, label: key.slice(0, 8) }
  session.worktree = worktree
  session.label = worktree ? path.basename(worktree) : key.slice(0, 8)
  session.state = payload.state
  session.updatedAt = Date.now()
  session.muted = isMuted(session)
  sessions.set(key, session)
  pruneSessions()
  return session
}

function isMuted(session) {
  return muted.has(session.key) || (session.worktree ? muted.has(session.worktree) : false)
}

function labelState(state) {
  if (state === 'working') return 'working'
  if (state === 'blocked') return 'blocked'
  if (state === 'waiting') return 'waiting'
  if (state === 'done') return 'finished'
  return state
}

function sessionPhase(session) {
  if (isMuted(session)) return 'muted'
  if (session.key === activeKey && phase !== 'quiet') return phase
  if (!enabled) return 'paused'
  if (session.state === 'working') return 'will speak when it finishes'
  if (session.state === 'done' && queued && queuedKey === session.key) return 'about to speak'
  return labelState(session.state || 'quiet')
}

function schedule(orca, worktree, key) {
  queuedWorktree = worktree
  queuedKey = key
  queued = true
  if (busy) return
  kick(orca)
}

function kick(orca) {
  const worktree = queuedWorktree
  const key = queuedKey
  queued = false
  busy = true
  const my = ++ticket
  setTimeout(() => {
    run(orca, my, worktree, key).finally(() => {
      busy = false
      if (queued && my === ticket) kick(orca)
    })
  }, 900)
}

async function run(orca, my, worktree, key) {
  const session = key ? sessions.get(key) : null
  activeKey = key
  try {
    if (!enabled) {
      phase = 'paused'
      record(`${session ? session.label : 'a chat'} finished while Read Aloud is off`)
      return
    }
    if (session && isMuted(session)) {
      phase = 'muted'
      record(`${session.label} is muted`)
      return
    }
    mic = await micOn()
    if (mic) {
      phase = 'mic'
      record('microphone is on, staying quiet')
      return
    }
    phase = 'about to speak'
    const reply = await waitForNewReply(worktree)
    if (my !== ticket) return
    if (!reply) {
      phase = 'quiet'
      record('finished, but no new reply was on disk')
      return
    }
    phase = 'summarizing'
    record(`${session ? session.label : 'chat'} is being summarized`)
    let summary = ''
    let claudeError = ''
    try {
      summary = await summarize(reply.text, () => my !== ticket)
    } catch (err) {
      claudeError = err instanceof Error ? err.message : String(err)
      summary = localSummary(reply.text)
      lastError = claudeError
      record(`summary failed, speaking a plain extract: ${claudeError}`)
    }
    if (my !== ticket || !summary) return
    mic = await micOn()
    if (mic) {
      phase = 'mic'
      record('microphone came on before speaking, staying quiet')
      return
    }
    heard.add(reply.id)
    phase = 'speaking'
    lastSpoken = summary
    record(claudeError ? 'speaking the plain extract' : 'speaking')
    await speak(summary, () => my !== ticket)
    phase = 'quiet'
    lastError = claudeError
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    phase = 'failed'
    lastError = message
    record('failed: ' + message)
    orca.log('read aloud failed: ' + message)
  } finally {
    if (activeKey === key && phase !== 'failed') activeKey = null
  }
}

function worktreePath(worktreeId) {
  if (typeof worktreeId !== 'string' || worktreeId.length === 0) return null
  const split = worktreeId.lastIndexOf('::')
  const value = split === -1 ? worktreeId : worktreeId.slice(split + 2)
  return value.startsWith('/') ? value : null
}

async function waitForNewReply(worktree) {
  const first = newestUnheard(worktree)
  if (first) return first
  await delay(2000)
  return newestUnheard(worktree)
}

function newestUnheard(worktree) {
  const files = listTranscripts()
  const matched = worktree ? files.filter((file) => fileMatches(file, worktree)) : []
  return unheardFrom(matched) ?? unheardFrom(files)
}

function unheardFrom(files) {
  const chosen = files
    .map((file) => ({ file, mtime: mtimeMs(file) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 4)
  for (const item of chosen) {
    const reply = lastReply(item.file)
    if (reply && !heard.has(reply.id)) return reply
  }
  return null
}

function currentReplies() {
  return listTranscripts()
    .map((file) => ({ file, mtime: mtimeMs(file) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 4)
    .map((item) => lastReply(item.file))
    .filter(Boolean)
}

function listTranscripts() {
  const found = []
  collectNamed(path.join(HOME, '.grok', 'sessions'), 'chat_history.jsonl', 4, found)
  collectSuffix(path.join(HOME, '.claude', 'projects'), '.jsonl', 2, found)
  collectCodex(path.join(HOME, '.codex', 'sessions'), found)
  return found
}

function collectNamed(root, name, depth, out) {
  walk(root, depth, (file) => {
    if (path.basename(file) === name) out.push(file)
  })
}

function collectSuffix(root, suffix, depth, out) {
  walk(root, depth, (file) => {
    if (file.endsWith(suffix)) out.push(file)
  })
}

function walk(root, depth, onFile) {
  if (!fs.existsSync(root)) return
  const stack = [[root, 0]]
  while (stack.length > 0) {
    const [dir, level] = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (level < depth) stack.push([full, level + 1])
        continue
      }
      if (!entry.isFile()) continue
      try {
        if (fs.statSync(full).size > 32 * 1024 * 1024) continue
      } catch {
        continue
      }
      onFile(full)
    }
  }
}

function collectCodex(root, out) {
  if (!fs.existsSync(root)) return
  const years = directories(root).sort()
  const year = years.at(-1)
  if (!year) return
  const months = directories(year).sort()
  const month = months.at(-1)
  if (!month) return
  for (const day of directories(month).sort().slice(-2)) {
    for (const name of fs.readdirSync(day)) {
      if (name.endsWith('.jsonl')) out.push(path.join(day, name))
    }
  }
}

function directories(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function fileMatches(file, worktree) {
  const parts = file.split(path.sep)
  for (const part of parts) {
    if (!part.includes('%')) continue
    try {
      const decoded = decodeURIComponent(part)
      if (decoded === worktree || worktree.startsWith(decoded + path.sep) || decoded.startsWith(worktree + path.sep)) {
        return true
      }
    } catch {
      // A directory name with a stray percent sign is not a workspace path.
    }
  }
  if (worktree.startsWith('/')) {
    const slug = '-' + worktree.slice(1).replaceAll('/', '-')
    if (parts.includes(slug)) return true
  }
  return false
}

export function lastReply(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line) continue
    const reply = decodeLine(line)
    if (reply) return reply
  }
  return null
}

export function decodeLine(line) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  if (!record || typeof record !== 'object') return null
  if (record.isMeta === true || record.isSidechain === true) return null

  if (record.type === 'response_item' && record.payload && record.payload.role === 'assistant') {
    return fromBlocks(record.payload.content, record.payload.id)
  }
  if (record.type === 'assistant' && record.message && Array.isArray(record.message.content)) {
    return fromBlocks(record.message.content, record.uuid)
  }
  if (record.type === 'assistant' || record.role === 'assistant') {
    if (typeof record.content === 'string' && record.content.trim()) {
      return { id: typeof record.id === 'string' ? record.id : stableId(record.content), text: record.content.trim() }
    }
    if (Array.isArray(record.content)) return fromBlocks(record.content, record.id)
  }
  return null
}

function fromBlocks(content, id) {
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const type = block.type
    if (type === 'thinking' || type === 'redacted_thinking' || type === 'reasoning') continue
    if (type === 'tool_use' || type === 'tool_result' || type === 'tool_call') continue
    if ((type === 'text' || type === 'output_text') && typeof block.text === 'string') parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  if (!text) return null
  return { id: typeof id === 'string' ? id : stableId(text), text }
}

function stableId(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function prepareForSummary(text) {
  const stripped = text
    .replace(/```[\s\S]*?```/g, '\n[code omitted]\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n[code omitted]\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const cap = 12000
  if (stripped.length <= cap) return stripped
  return stripped.slice(stripped.length - cap)
}

export function cleanSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function micOn() {
  if (!fs.existsSync(MIC)) return Promise.resolve(false)
  return new Promise((resolve) => {
    const child = spawn(MIC, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve(false)
    }, 1500)
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out.trim() === 'yes')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

function claudeEnv() {
  const env = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

export function localSummary(text) {
  const plain = cleanSpeech(prepareForSummary(text).replaceAll('[code omitted]', ' '))
  if (!plain) return 'That reply was only code.'
  const cut = plain.slice(0, 420)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return end > 80 ? cut.slice(0, end + 1) : cut
}

export function summarize(text, cancelled = () => false) {
  const prepared = prepareForSummary(text)
  if (!prepared) return Promise.resolve('')
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, [
      '-p',
      '--output-format', 'text',
      '--tools', '',
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--effort', 'low',
      '--strict-mcp-config',
      '--system-prompt', SPOKEN_SYSTEM
    ], {
      cwd: HOME,
      env: claudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    claudeChild = child
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, 25000)
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      if (claudeChild === child) claudeChild = null
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (claudeChild === child) claudeChild = null
      if (cancelled()) {
        resolve('')
        return
      }
      const spoken = cleanSpeech(out)
      if (code !== 0 || !spoken) {
        reject(new Error((err || out || `claude exited ${code}`).trim().slice(0, 300)))
        return
      }
      resolve(spoken)
    })
    child.stdin.write(prepared)
    child.stdin.end()
  })
}

function speak(text, cancelled) {
  if (speech) {
    speech.kill('SIGTERM')
    speech = null
  }
  return new Promise((resolve, reject) => {
    const child = spawn(SAY, ['-r', '175'], { stdio: ['pipe', 'ignore', 'pipe'] })
    speech = child
    let err = ''
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (speech === child) speech = null
      if (cancelled()) {
        resolve()
        return
      }
      if (code !== 0 && code !== null) reject(new Error((err || `say exited ${code}`).trim()))
      else resolve()
    })
    child.stdin.write(text)
    child.stdin.end()
  })
}

function stopAudio() {
  if (claudeChild) {
    claudeChild.kill('SIGTERM')
    claudeChild = null
  }
  if (speech) {
    speech.kill('SIGTERM')
    speech = null
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    enabled = raw.enabled !== false
    if (Array.isArray(raw.muted)) {
      for (const key of raw.muted) {
        if (typeof key === 'string' && key) muted.add(key)
      }
    }
  } catch {
    enabled = true
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled, muted: [...muted] }))
}

function record(text) {
  activity.unshift({ t: Date.now(), text })
  if (activity.length > 40) activity.pop()
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`)
  } catch {
    // The board still has the line if the log file cannot be written.
  }
}

function pruneSessions() {
  const ranked = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const session of ranked.slice(20)) sessions.delete(session.key)
}

function snapshot() {
  const rows = [...sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => ({
      key: session.key,
      label: session.label,
      state: labelState(session.state || 'quiet'),
      phase: sessionPhase(session),
      muted: isMuted(session)
    }))
  return {
    enabled,
    mic,
    phase,
    lastError,
    lastSpoken,
    activity,
    sessions: rows
  }
}

function startHotkey() {
  const bin = path.join(HERE, 'stop-hotkey')
  if (!fs.existsSync(bin)) return
  const child = spawn(bin, [], { stdio: 'ignore', detached: true })
  child.unref()
}

function startBoard() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(BOARD_HTML)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(snapshot()))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 8000) req.destroy()
    })
    req.on('end', () => {
      let payload = {}
      try {
        payload = body ? JSON.parse(body) : {}
      } catch {
        payload = {}
      }
      if (url.pathname === '/api/enabled') {
        enabled = payload.on !== false
        saveState()
        record(enabled ? 'turned on' : 'turned off')
      } else if (url.pathname === '/api/mute') {
        const key = typeof payload.key === 'string' ? payload.key : ''
        if (key) {
          if (muted.has(key)) muted.delete(key)
          else muted.add(key)
          saveState()
          record(muted.has(key) ? `muted ${key}` : `unmuted ${key}`)
        }
      } else if (url.pathname === '/api/stop') {
        halt(null, 'stopped from the board')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(snapshot()))
    })
  })
  server.listen(BOARD_PORT, '127.0.0.1', () => {
    spawn('/usr/bin/open', [`http://127.0.0.1:${BOARD_PORT}`], { stdio: 'ignore' })
  })
  server.on('error', (err) => {
    record(`board did not start: ${err.message}`)
  })
}

const BOARD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Read Aloud</title>
<style>
  :root { color-scheme: light dark; --fg: #1c1c1c; --muted: #5c5c5c; --line: #ddd; --bg: #fafafa; --card: #fff; --on: #0b6b4f; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #eee; --muted: #9a9a9a; --line: #333; --bg: #161616; --card: #222; --on: #7dcea0; }
  }
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  header, main { padding: 14px 16px; }
  header { display: flex; justify-content: space-between; gap: 12px; align-items: center; border-bottom: 1px solid var(--line); }
  h1 { font-size: 15px; margin: 0; }
  button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--fg); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
  .on { color: var(--on); font-weight: 600; }
  .err { color: #a33; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  .log { margin: 0; padding: 0; list-style: none; }
  .log li { padding: 4px 0; border-bottom: 1px solid var(--line); color: var(--muted); }
  .log b { color: var(--fg); font-weight: 500; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Read Aloud</h1>
    <div id="sub"></div>
  </div>
  <div>
    <button id="power"></button>
    <button id="stop">Stop</button>
  </div>
</header>
<main>
  <p id="error" class="err"></p>
  <p id="spoken"></p>
  <table>
    <thead><tr><th>Chat</th><th>Model</th><th>Speech</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <h2 style="font-size:13px;margin:16px 0 6px">What happened</h2>
  <ul class="log" id="log"></ul>
</main>
<script>
function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json())
}
function draw(state) {
  document.getElementById('power').textContent = state.enabled ? 'On' : 'Off'
  document.getElementById('power').className = state.enabled ? 'on' : ''
  const mic = state.mic ? 'Microphone is on, so speech stays quiet.' : 'Microphone is off.'
  document.getElementById('sub').textContent = mic + ' Now: ' + state.phase + '.'
  document.getElementById('error').textContent = state.lastError || ''
  document.getElementById('spoken').textContent = state.lastSpoken ? 'Last spoken: ' + state.lastSpoken : ''
  document.getElementById('rows').innerHTML = state.sessions.map(function (row) {
    const mute = row.muted ? 'Unmute' : 'Mute'
    return '<tr><td>' + escapeHtml(row.label) + '</td><td>' + escapeHtml(row.state) + '</td><td>' + escapeHtml(row.phase) + '</td><td><button data-key="' + escapeHtml(row.key) + '">' + mute + '</button></td></tr>'
  }).join('') || '<tr><td colspan="4">No chats yet. Status shows up when an agent changes state.</td></tr>'
  document.getElementById('log').innerHTML = state.activity.map(function (line) {
    const time = new Date(line.t).toLocaleTimeString()
    return '<li><b>' + time + '</b> ' + escapeHtml(line.text) + '</li>'
  }).join('')
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  })
}
document.getElementById('power').onclick = function () {
  const on = document.getElementById('power').textContent !== 'On'
  post('/api/enabled', { on: on }).then(draw)
}
document.getElementById('stop').onclick = function () { post('/api/stop').then(draw) }
document.getElementById('rows').onclick = function (event) {
  const key = event.target && event.target.getAttribute && event.target.getAttribute('data-key')
  if (key) post('/api/mute', { key: key }).then(draw)
}
function tick() { fetch('/api/state').then(r => r.json()).then(draw).catch(function () {}) }
tick()
setInterval(tick, 1000)
</script>
</body>
</html>`
