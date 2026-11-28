import type { Hook, Register } from 'claude-code'

// watchd: long-lived event watchers for a Claude Code session, with no
// 30-minute cap. A watch is a command; each line it prints on stdout is an
// event. Events are batched and handed to the model as a plugin prompt,
// which starts a turn once the session is idle (so it wakes a quiet one).
// A plugin prompt only ever lands between turns, so while a main-loop turn
// runs, events are held and handed to the model after each batch of tool
// calls instead (PostToolBatch additionalContext); what is left when the turn
// ends is submitted then. A long single tool call still holds them until it
// returns: nothing gets in mid-call.
//
// Watches come from <session cwd>/.claude/watchd.json, re-read every POLL_MS:
// the directory the session started in, pinned, not wherever its shell is now.
// an added watch starts, a removed one is stopped, a changed one restarts.
//   { "watches": [
//       { "name": "irc",    "argv": ["bash", "tools/tail-irc.sh"] },
//       { "name": "alarms", "command": "tail -n0 -F a.log | grep --line-buffered X" } ] }
// `command` runs under `bash -c`; `argv` runs as is, both in that same
// directory, so relative paths resolve there. No file, no watches.
//
// A watch that exits is reported and restarted after RESTART_MS. One that
// exits MAX_FAILS times in a row, each within STABLE_MS of its start, is given
// up, and that is reported too. The status line reads `watchd up/total`, with
// the names of the watches that are down.
//
// Every child, and everything it forks, carries WATCHD=<name> and
// WATCHD_DIR=<session cwd> in its environment, so a script can tell watchd
// is on for its project (other sessions' watches carry other dirs):
//   grep -lsxzF "WATCHD_DIR=$PWD" /proc/[0-9]*/environ

type Watch = { name: string; argv?: string[]; command?: string; seen?: string[] | string }
type Held = { name: string; line: string }
type Entry = { key: string; stopped: boolean; child?: AsyncGenerator<unknown, unknown> }

const CONFIG = '.claude/watchd.json'
const POLL_MS = 5_000
const BATCH_MS = 200
const RESTART_MS = 30_000
const STABLE_MS = 600_000
const MAX_FAILS = 5

const keyOf = (w: Watch) => JSON.stringify([w.argv, w.command])
const isValid = (w: Watch) => typeof w?.name === 'string' &&
  (Array.isArray(w.argv) ? w.argv.length > 0 : typeof w?.command === 'string')

type Dollar = Parameters<Hook<'session.start'>>[0]

// Lines waiting for the model, the main loop's running turn, and whether a
// submitted prompt has yet to start its turn (so no second one goes out).
let held: Held[] = []
let turn: string | undefined
let submitted = false
let timer = false
// The session's directory, and each watch's `seen` command, from the config.
let home = ''
const seenOf = new Map<string, string[]>()

// Takes what is held, as the text the model reads, and runs the `seen`
// command of each watch with lines in it, those lines on its stdin (no
// prefix), so a watch can tell its source they reached the model.
function take($: Dollar): string {
  const batch = held
  held = []
  const byName = new Map<string, string[]>()
  for (const { name, line } of batch) byName.set(name, [...(byName.get(name) ?? []), line])
  for (const [name, lines] of byName) {
    const argv = seenOf.get(name)
    if (!argv) continue
    void (async () => {
      try {
        for await (const _ of $.process.spawn({ argv, cwd: home, input: lines.join('\n') + '\n' })) { /* drain */ }
      } catch (err) {
        $.ui.log(`watchd ${name}: seen failed: ${err}`, { to: 'debug' })
      }
    })()
  }
  return batch.map(h => `[${h.name}] ${h.line}`).join('\n')
}

// Idle: submit what is held, one prompt per BATCH_MS. Never awaited, so a
// prompt the engine keeps queued can not stall the lines behind it.
function flush($: Dollar) {
  if (timer) return
  timer = true
  void (async () => {
    await $.clock.sleep(BATCH_MS)
    timer = false
    if (turn || submitted || !held.length) return
    const text = take($)
    submitted = true
    $.prompt.submit({ text })
      .catch(err => $.ui.log(`watchd: submit failed: ${err}`, { to: 'debug' }))
      .finally(() => { submitted = false; flush($) })
  })()
}

export const register: Register = on => {
  let started = false

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) { turn = e.turnId; submitted = false }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && turn === e.turnId) { turn = undefined; flush($) }
    return result
  })

  // Between tool calls of the main loop's turn: what arrived meanwhile goes in.
  on('classic.PostToolBatch', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined || !held.length) return result
    const text = take($)
    return { ...result, additionalContext: [...(result.additionalContext ?? []), text] }
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (started) return result
    started = true

    // Pinned at start: the session's working directory moves with a `cd` in
    // its shell, and a relative config path would then read as missing and
    // stop every watch.
    const dir = e.cwd
    home = dir
    const config = `${dir}/${CONFIG}`

    const entries = new Map<string, Entry>()
    const states = new Map<string, 'up' | 'restarting' | 'dead'>()

    const emit = (name: string, line: string) => {
      held.push({ name, line })
      flush($)
    }

    const showStatus = () => {
      if (!states.size) return $.ui.status(undefined)
      const down = [...states].filter(([, s]) => s !== 'up').map(([n]) => n)
      const up = states.size - down.length
      $.ui.status(`watchd ${up}/${states.size}${down.length ? ` down: ${down.join(',')}` : ''}`)
    }

    // A loop left behind by a stop must not touch the state of its successor.
    const setState = (name: string, entry: Entry, s: 'up' | 'restarting' | 'dead') => {
      if (entries.get(name) !== entry) return
      states.set(name, s)
      showStatus()
    }


    const run = async (w: Watch, entry: Entry) => {
      const argv = w.argv ?? ['bash', '-c', w.command as string]
      let fails = 0
      while (!entry.stopped) {
        const startedAt = await $.clock.now()
        setState(w.name, entry, 'up')
        let partial = ''
        let how: string
        try {
          const child = $.process.spawn({ argv, cwd: dir, env: { WATCHD: w.name, WATCHD_DIR: dir } })
          entry.child = child
          for await (const { stream, text } of child) {
            if (stream === 'stderr') {
              $.ui.log(`watchd ${w.name}: ${text}`, { to: 'debug' })
              continue
            }
            const lines = (partial + text).split('\n')
            partial = lines.pop() ?? ''
            for (const line of lines) if (line.trim()) emit(w.name, line)
          }
          const { code, signal } = await child.result
          how = signal ? `signal ${signal}` : `code ${code}`
        } catch (err) {
          how = `failed: ${err}`
        }
        if (entry.stopped) return
        if (partial.trim()) emit(w.name, partial)
        fails = (await $.clock.now()) - startedAt > STABLE_MS ? 1 : fails + 1
        const dead = fails >= MAX_FAILS
        setState(w.name, entry, dead ? 'dead' : 'restarting')
        emit('watchd', `${w.name} exited (${how}); ` +
          (dead ? `given up after ${fails} quick exits` : `restarting in ${RESTART_MS / 1000}s`))
        if (dead) return
        await $.clock.sleep(RESTART_MS)
      }
    }

    let lastText: string | undefined
    let busy = false
    const reconcile = async () => {
      if (busy) return
      busy = true
      try {
        const text = (await $.fs.exists(config)) ? ((await $.fs.read(config)) as string) : ''
        if (text === lastText) return
        lastText = text
        let watches: Watch[] = []
        try {
          if (text) watches = JSON.parse(text).watches ?? []
        } catch (err) {
          emit('watchd', `${CONFIG} is not valid JSON, watches left as they were: ${err}`)
          return
        }
        const want = new Map<string, Watch>()
        for (const w of watches) {
          if (isValid(w)) want.set(w.name, w)
          else emit('watchd', `${CONFIG}: skipped invalid watch ${JSON.stringify(w)}`)
        }
        seenOf.clear()
        for (const [name, w] of want) {
          if (Array.isArray(w.seen) && w.seen.length) seenOf.set(name, w.seen)
          else if (typeof w.seen === 'string') seenOf.set(name, ['bash', '-c', w.seen])
        }
        for (const [name, entry] of entries) {
          const w = want.get(name)
          if (w && keyOf(w) === entry.key) continue
          entry.stopped = true
          void entry.child?.return(undefined) // kills the child
          entries.delete(name)
          states.delete(name)
          if (!w) emit('watchd', `${name} stopped (removed from ${CONFIG})`)
        }
        for (const [name, w] of want) {
          if (entries.has(name)) continue
          const entry: Entry = { key: keyOf(w), stopped: false }
          entries.set(name, entry)
          void run(w, entry)
        }
        showStatus()
      } catch (err) {
        $.ui.log(`watchd: reading ${CONFIG} failed: ${err}`, { to: 'debug' })
      } finally {
        busy = false
      }
    }

    await reconcile()
    $.clock.every(POLL_MS, () => { void reconcile() })
    return result
  })
}
