# watchd

A Claude Code mod that keeps event watchers running for the whole life of a
session. Each watch is a command; every line it prints on stdout reaches the
model as an event, and wakes the session if it is idle.

It replaces the built-in `Monitor` tool for long-running watches. `Monitor`
caps every watch at 30 minutes, so a session that tails logs all day re-arms
each watch twice an hour, spending a turn each time for nothing. watchd has no
cap: a watch runs until the session ends, it exits, or you remove it.

## Install

Point Claude Code at this folder. For every session on the machine, add it to
the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-watchd" } }
```

For one session: `claude --plugin-dir /path/to/claude-watchd`. Sessions read
the variable at start, so restart them once.

The mod does nothing in a project without a config file, so it is safe to load
everywhere.

## Configure

Each project lists its watches in `.claude/watchd.json`, under the session's
working directory:

```json
{
  "watches": [
    { "name": "bot",    "argv": ["bash", "tools/tail-bot-events.sh"] },
    { "name": "alarms", "command": "tail -n0 -F ~/alarms.log | grep --line-buffered -v '^$'" }
  ]
}
```

- `argv` runs as is; `command` runs under `bash -c`.
- Relative paths resolve against the session's working directory.
- The file is re-read every 5 seconds: add an entry and it starts, remove it and
  it stops, change it and it restarts. No restart of the session needed, so a
  temporary watch is one edit away.

Filter in the command, not in the model: every line printed is a turn. Flush
per line (`grep --line-buffered`, `awk` with `fflush()`, `stdbuf -oL`), or
events sit in a pipe buffer.

## What the model sees

Lines are batched (200 ms) and submitted as a plugin prompt, one turn per
batch, prefixed with the watch name:

```
[bot] MSG FROM=alice BODY=hello
[alarms] disk 91% on /srv
```

Claude Code starts a plugin prompt only once the session is idle, so lines that
arrive while a turn runs are held and handed to the model after each batch of
tool calls, as hook context (PostToolBatch), without interrupting the turn.
Whatever is still held when the turn ends is submitted then. A single long tool
call (a blocking hook, a long foreground command) holds them until it returns.

A watch may name a `seen` command (`argv` list, or a string for `bash -c`): it
runs whenever that watch's lines are handed to the model, with those lines,
unprefixed, on its stdin. Use it to tell the source they were read (claude-tgbot
puts a 👀 on the Telegram messages):

```json
{ "name": "tg", "command": "tail -F -n0 bot.stdout.log",
  "seen": ["python3", "/path/to/claude-tgbot/hooks/turn.py", "--seen", "/path/to/consumer"] }
```

## Failures

- A watch that exits is reported (`[watchd] bot exited (code 1); restarting in 30s`)
  and restarted after 30 seconds.
- Five exits in a row, each within 10 minutes of starting, and it is given up,
  which is reported too.
- An unreadable or invalid `watchd.json` is reported, and the running watches
  are left as they were.
- The status line reads `watchd 3/3`, or `watchd 2/3 down: alarms`.
- stderr of a watch goes to the debug log (`claude --debug`), not to the model.

## Telling watchd is on

Every child, and everything it forks, carries `WATCHD=<name>` and
`WATCHD_DIR=<session working directory>` in its environment. A startup script
that would otherwise attach `Monitor`s checks for its own project, since other
sessions' watches carry their own directory:

```bash
grep -lsxzF "WATCHD_DIR=$PWD" /proc/[0-9]*/environ | wc -l
```

## Caveat

After `/clear` Claude Code does not run `session.start` again. If the watches
do not outlive a `/clear` on your version, the next session start brings them
back; the check above tells you which case you are in.

## License

MIT
