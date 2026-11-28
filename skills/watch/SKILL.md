---
name: watch
description: Add, change, remove or list the session-long watches of watchd (.claude/watchd.json). Use when the user asks to watch, tail, follow or monitor a log, a file, a command, a service or a queue for the whole session, to be told when something happens, to stop watching something, or what is being watched. Use it instead of the Monitor tool for anything meant to last longer than one task.
---

# Watches with watchd

A watch is a command whose every stdout line reaches you as an event, for as
long as the session lives: it starts a turn when the session is idle, and gets
in between your tool calls when a turn is running. watchd re-reads the config
every 5 seconds, so editing the file is all it takes: no restart.

## The file

`.claude/watchd.json` in the directory the session started in (not wherever
the shell has `cd`'d since):

```json
{
  "watches": [
    { "name": "nginx", "command": "tail -n0 -F /var/log/nginx/error.log" },
    { "name": "bot",   "argv": ["bash", "tools/bot-events.sh"],
      "seen": ["python3", "tools/ack.py"] }
  ]
}
```

- `name`: short, unique, lowercase; it prefixes every line (`[nginx] …`).
- `command` runs under `bash -c`; `argv` runs as is. Relative paths resolve
  against the session's start directory.
- `seen` (optional): run with the lines of this watch on stdin each time they
  reach you. For telling the source "read" (a 👀 on a chat message).

## Adding a watch

1. **Make the command quiet.** Every line costs a read, and on an idle session
   a whole turn. Filter in the command, never in the model: `grep`, `awk`, a
   script that prints only what someone must act on. A watch that prints
   hundreds of lines an hour is wrong.
2. **No replay.** Start at the end: `tail -n0 -F` (with `-F`, it survives
   rotation), `journalctl -f -n0 -o cat -u <unit>`. A watch is restarted when it
   exits, and a replay on each restart re-delivers old events.
3. **One line per event, flushed.** Through a pipe: `grep --line-buffered`,
   `awk '{ print; fflush() }'`, `stdbuf -oL <cmd>`, Python `-u` or
   `print(..., flush=True)`. Unflushed, events sit in a buffer for minutes.
4. **Polling** (an API, a queue, a page): a loop that prints only on change,
   e.g. `prev=; while sleep 60; do cur=$(<probe>); [ "$cur" != "$prev" ] && echo "$cur"; prev=$cur; done`.
5. **No secrets in the output.** What a watch prints lands in the transcript.
6. **Try it by hand first**, bounded: `timeout 15 bash -c '<command>'`, and
   make an event happen if you can. No output when there should be some means
   buffering or a wrong filter.
7. **Edit the file read-modify-write**, keeping every other entry, and keep it
   valid JSON (`python3 -m json.tool .claude/watchd.json`): an invalid file is
   reported and ignored, the running watches stay as they were. Create the file,
   and `.claude/`, if missing.
8. **Check it started**, a few seconds later:
   `grep -lsxzF "WATCHD=<name>" /proc/[0-9]*/environ | head -1` (Linux), or ask
   the user to run `/watchd`, which lists every watch with its state and last
   line.

Tell the user in one line what is watched and what will wake you.

## Changing, stopping, listing

- **Change**: edit the entry; a changed `command`/`argv` restarts that watch,
  a changed `seen` does not.
- **Stop**: delete the entry; watchd stops it and says so.
- **List**: read the file; `/watchd` shows live state, lines, restarts.

## When events arrive

Each line comes as `[<name>] <line>`. Act on it, or ignore it when it needs
nothing: say nothing about events that change nothing. A line
`[watchd] <name> exited (…); restarting in 30s` is the watch itself failing;
five quick exits and it is given up: look at the command.
