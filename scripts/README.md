# scripts/

Developer helper scripts for working on pgrest-lambda. Nothing here ships in the
npm package or gets deployed — these are local workflow tools.

## check-error-docs.mjs — does the error reference still match the engine?

```bash
npm run docs:check-errors
```

Reads `docs/reference/errors.md` and the engine's sources, then fails if either
half has drifted:

- a message documented in a `| 4xx | \`text\` |` row that no longer appears in
  `src/` — the wording changed and the page still shows the old one
- a `PGRST*` code the engine constructs with no `###` section on the page

`{placeholders}` in a documented message stand for interpolations, so
`Could not find the table '{schema}.{table}' in the schema cache` matches the
template literal that builds it. Exit code is 1 on any mismatch, so this can run
in CI.

It checks strings and codes, not prose. A row can pass here and still describe
the wrong cause.

## dev-session.sh — persistent tmux session

Keeps Claude Code (and anything else you started) running on this machine after
you close the terminal or your SSH connection drops. Reconnect later and pick up
in the same session, with scrollback and running processes intact.

### Requirements

- `tmux` (installed at `/usr/bin/tmux` on this host; otherwise `sudo dnf install -y tmux`)
- `claude` on `PATH` — optional. Without it the script still builds the session
  and leaves window 0 at a shell prompt.

### Everyday workflow

```bash
# from your remote PC
ssh ec2-user@<host>
cd ~/pgrest-lambda
scripts/dev-session.sh          # creates the session on first run, attaches after that
```

Work with Claude in window 0. When you're done for now:

- `Ctrl-b` then `d` — detach and leave everything running, or
- just close the terminal / let the connection drop. Same result: the tmux
  server keeps the session alive.

Next time you SSH in, run `scripts/dev-session.sh` again to reattach.

### Commands

| Command | What it does |
| --- | --- |
| `scripts/dev-session.sh` | Start the session, or attach if it already exists (default) |
| `scripts/dev-session.sh attach` | Attach only; exits non-zero if the session is gone |
| `scripts/dev-session.sh status` | Show whether it's running, its windows, and attached clients |
| `scripts/dev-session.sh list` | List every tmux session on the machine |
| `scripts/dev-session.sh kill` | Kill the session — this stops Claude and any running command |
| `scripts/dev-session.sh restart` | Kill it and start fresh |

### Options

| Option | Effect |
| --- | --- |
| `-n`, `--name NAME` | Use a different session name (default `pgrest`). One per branch or feature if you like: `-n pgrest-v13` |
| `-d`, `--takeover` | Detach any other client as you attach. Use this when a dead client from a dropped connection is squeezing your panes (applies when attaching from outside tmux) |
| `--no-claude` | Build the session but leave window 0 at a shell prompt |
| `-h`, `--help` | Print the usage block from the top of the script |

### Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `PGREST_TMUX_SESSION` | `pgrest` | Session name, same as `--name` |
| `PGREST_CLAUDE_CMD` | `claude` | Command run in window 0. May include arguments, e.g. `PGREST_CLAUDE_CMD='claude --resume'` |
| `PGREST_TMUX_SCROLLBACK` | `50000` | Lines of scrollback per pane |

### What the session looks like

Three windows, each starting in the repo root:

```
0:claude   runs `claude`
1:shell    tests, npm scripts, rring commands
2:git      status, diffs, commits
```

Move between them with `Ctrl-b 0` / `Ctrl-b 1` / `Ctrl-b 2`, or `Ctrl-b n` and
`Ctrl-b p`.

Session settings applied on creation: mouse mode on, 50k scrollback,
`destroy-unattached off` (survives disconnects), and `aggressive-resize on` so a
leftover client doesn't shrink your windows. These are set per session — the
script bumps the global `history-limit` only long enough to create the windows,
then restores it, so your `~/.tmux.conf` and other tmux sessions are unaffected.

### Useful tmux keys

| Keys | Action |
| --- | --- |
| `Ctrl-b d` | Detach, leaving everything running |
| `Ctrl-b [` | Enter copy mode to scroll; `q` to leave (mouse wheel also scrolls) |
| `Ctrl-b c` | New window |
| `Ctrl-b ,` | Rename the current window |
| `Ctrl-b %` / `Ctrl-b "` | Split the pane vertically / horizontally |
| `Ctrl-b z` | Zoom the current pane full-screen, again to unzoom |

### Notes and gotchas

- **Reboots don't survive.** tmux keeps sessions across disconnects, not across
  an instance restart. After a reboot, run the script again.
- **Run it from inside tmux** and it switches the current client to the session
  instead of nesting.
- **Long Claude runs keep going while you're detached** — that's the point. Check
  in with `scripts/dev-session.sh status` before attaching if you want to know
  whether anyone else is already attached.
- The script only ever touches the session it's named for, so running several in
  parallel with `-n` is safe.
