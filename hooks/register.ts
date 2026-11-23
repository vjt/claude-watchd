import type { Register } from 'claude-code'

// watchd: long-lived event watchers for a Claude Code session, with no
// 30-minute cap. A watch is a command; each line it prints on stdout is an
// event. Events are batched and handed to the model as a plugin prompt,
// which starts a turn once the session is idle (so it wakes a quiet one).
//
// Watches come from <session cwd>/.claude/watchd.json, re-read every POLL_MS:
// an added watch starts, a removed one is stopped, a changed one restarts.
//   { "watches": [
//       { "name": "irc",    "argv": ["bash", "tools/tail-irc.sh"] },
//       { "name": "alarms", "command": "tail -n0 -F a.log | grep --line-buffered X" } ] }
// `command` runs under `bash -c`; `argv` runs as is. Relative paths resolve
// against the session's working directory. No file, no watches.
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

type Watch = { name: string; argv?: string[]; command?: string }
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

export const register: Register = on => {
  let started = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (started) return result
    started = true

    let queue: string[] = []
    let flushing = false
    const entries = new Map<string, Entry>()
    const states = new Map<string, 'up' | 'restarting' | 'dead'>()

    const emit = (line: string) => {
      queue.push(line)
      if (flushing) return
      flushing = true
      void (async () => {
        try {
          while (queue.length) {
            await $.clock.sleep(BATCH_MS)
            const text = queue.join('\n')
            queue = []
            await $.prompt.submit({ text })
          }
        } catch (err) {
          $.ui.log(`watchd: submit failed: ${err}`, { to: 'debug' })
        } finally {
          flushing = false
        }
      })()
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

    const dir = e.cwd

    const run = async (w: Watch, entry: Entry) => {
      const argv = w.argv ?? ['bash', '-c', w.command as string]
      let fails = 0
      while (!entry.stopped) {
        const startedAt = await $.clock.now()
        setState(w.name, entry, 'up')
        let partial = ''
        let how: string
        try {
          const child = $.process.spawn({ argv, env: { WATCHD: w.name, WATCHD_DIR: dir } })
          entry.child = child
          for await (const { stream, text } of child) {
            if (stream === 'stderr') {
              $.ui.log(`watchd ${w.name}: ${text}`, { to: 'debug' })
              continue
            }
            const lines = (partial + text).split('\n')
            partial = lines.pop() ?? ''
            for (const line of lines) if (line.trim()) emit(`[${w.name}] ${line}`)
          }
          const { code, signal } = await child.result
          how = signal ? `signal ${signal}` : `code ${code}`
        } catch (err) {
          how = `failed: ${err}`
        }
        if (entry.stopped) return
        if (partial.trim()) emit(`[${w.name}] ${partial}`)
        fails = (await $.clock.now()) - startedAt > STABLE_MS ? 1 : fails + 1
        const dead = fails >= MAX_FAILS
        setState(w.name, entry, dead ? 'dead' : 'restarting')
        emit(`[watchd] ${w.name} exited (${how}); ` +
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
        const text = (await $.fs.exists(CONFIG)) ? ((await $.fs.read(CONFIG)) as string) : ''
        if (text === lastText) return
        lastText = text
        let watches: Watch[] = []
        try {
          if (text) watches = JSON.parse(text).watches ?? []
        } catch (err) {
          emit(`[watchd] ${CONFIG} is not valid JSON, watches left as they were: ${err}`)
          return
        }
        const want = new Map<string, Watch>()
        for (const w of watches) {
          if (isValid(w)) want.set(w.name, w)
          else emit(`[watchd] ${CONFIG}: skipped invalid watch ${JSON.stringify(w)}`)
        }
        for (const [name, entry] of entries) {
          const w = want.get(name)
          if (w && keyOf(w) === entry.key) continue
          entry.stopped = true
          void entry.child?.return(undefined) // kills the child
          entries.delete(name)
          states.delete(name)
          if (!w) emit(`[watchd] ${name} stopped (removed from ${CONFIG})`)
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
