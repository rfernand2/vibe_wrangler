# Vibe Wrangler

A lightweight web app for managing **projects** and **tasks** that a **coding-agent CLI** works on for you.

It is built as a general harness for driving agent CLIs — the app owns the board, the git isolation, the
process supervision and the progress reporting, and treats the agent itself as a swappable command it
shells out to. **Claude Code is the first supported CLI**, and currently the only one: the app speaks its
`--output-format stream-json` transcript. Adding another means teaching `agent.js` that CLI's flags and
output format; nothing above it needs to change.

The point: you keep a clean, human-readable board of work. The agent picks up tasks, does the work, and
reports back in short, user-level comments — you never have to wade through tool calls, diffs, or token noise
unless you actually want to.

```
Projects  ──▶  Tasks  ──▶  Comments
                 │             ▲
                 └── agent ────┘
```

![The Vibe Wrangler board: projects down the left, tasks in the middle, an active task showing its checklist half ticked off](docs/screenshot.png)

## Features

- **Projects** — create / edit / delete. Each project points at a working directory on disk (that's where the agent runs).
- **Tasks** — create / edit / delete, grouped and filterable by status. Each is numbered from `#1`
  within its project. A number is retired when its task is deleted, so it never comes to mean
  something else later.
- **Tags** — label tasks with anything you like (`bug`, `backend`, `v2`). Tags are normalized (trimmed,
  lower-cased, de-duplicated) so `Backend` and `backend ` are the same tag.
- **Right-click a task** to toggle review tags on and off without opening it — `needs review`,
  `reviewed` and `verified` to begin with. **New tag…** adds your own, and it stays on the menu for
  every task from then on, whether or not anything currently carries it.
- **All tasks view** — one board showing every task across every project, filterable by tag *and* status.
  Useful for "show me everything tagged `release` no matter which repo it lives in".
- **Statuses**
  - `ready` — queued for the agent to pick up
  - `active` — the agent is working on it right now
  - `completed` — the agent finished
  - **anything else** (`blocked`, `on hold`, `idea`, …) — user-defined; the agent ignores these
- **Comments** — an append-only conversation per task. The agent writes progress notes while it works and a
  summary when it finishes. You can add your own comments too (review notes, test results, follow-ups).
- **Attachments** — paste a screenshot straight into a task description or a comment, drop files onto
  either box, or use **Attach files**. Images render inline; everything else becomes a download link.
  The agent sees each attachment as a path to a real file on disk, so it can open your mock-up, log or
  spec rather than being told one exists.
- **Checklists** — the agent breaks each task into sub-tasks up front and ticks them off as it goes, so you
  can see how far through it is rather than just "active". A task's checklist opens itself on the board
  while the agent is working and folds away once it stops; the triangle beside any task overrides that
  either way. Starting a new run reveals the fresh checklist again.
- **Run timer** — a live elapsed clock while a task is active, and the final duration once it finishes.
- **Raw logs** — the full technical transcript of each agent run is saved to disk and linked from the task,
  so it's there when you need it and out of the way when you don't.
- **Retry failed** — a run that fails leaves the task in `failed` with its work parked on a branch.
  **Retry failed** re-runs every failed task in the project; the retry gets a *new* branch, so the
  branch holding the earlier attempt's work is never deleted out from under you.
- **Agents** — a dialog listing every agent process the app knows about, with a Stop button for each.
  This includes agents inherited from an earlier run of the app, not just ones this instance started.
- **Live** — the board updates itself. There is no Refresh button because there is nothing to refresh:
  the server pushes a notification whenever anything changes and every open tab refetches.
- **Local & private** — everything lives in a single SQLite file. No cloud, no API keys.

## Why a CLI (not the API)

The agent is invoked by shelling out to the `claude` CLI in non-interactive (`-p`) mode. That means it uses
**your existing Claude subscription login** — there is no `ANTHROPIC_API_KEY` to manage and no per-token billing.
It also keeps the integration surface tiny: an agent is a command, a working directory and a stream of output,
which is why swapping in a different CLI is a contained change rather than a rewrite.

## Requirements

- **Node.js 22+** (uses the built-in `node:sqlite` module — no `npm install`, zero dependencies)
- **An agent CLI** on your `PATH` — today that means the **Claude Code CLI**, already logged in
  (`claude` → `/login`)

## Quick start

> ⚠️ **Before you start:** the agent runs with `--dangerously-skip-permissions` and will edit files and run
> commands in your project directory without asking. Read [Permissions](#permissions-read-this) first.

Windows:

```bat
run.bat
```

macOS / Linux:

```sh
./run.sh
```

Either script checks your prerequisites, starts the server and opens <http://localhost:3000> in your browser.
To use a different port:

```bat
set PORT=4000 && run.bat
```

```sh
PORT=4000 ./run.sh
```

## How a task gets worked

1. You create a project pointing at a repo directory.
2. You add a task with a title and a description of what you want done.
3. Set the task to **ready** and hit **Run** (or **Run all ready** on the project).
4. The app flips the task to **active** and launches:
   `claude -p "<task prompt>" --output-format stream-json` in the project directory.
5. While it works, the app watches the agent's output for three prefixes and drops everything else:

   | Line | Becomes |
   | --- | --- |
   | `NOTE: <sentence>` | a user-level comment on the task |
   | `PLAN: <sub-task>` | a new checklist item |
   | `DONE: <sub-task>` | that checklist item, ticked off |

   `DONE:` matches on words rather than exact text, so the agent rewording an item slightly still ticks
   the right box. The checklist is cleared at the start of each run, so it always describes the run you
   are looking at.
6. When it's done, the final summary is saved as a comment and the task flips to **completed** (or back to
   `ready` with an error comment if the run failed).

You then review the comments, test the change, and either close it out or add a follow-up task.

A run is normally finalized when the CLI exits. It doesn't always get that far: a background process the
agent started — a dev server, a poll loop — inherits the output pipe and can hold it open long after the
agent has said its piece. So the terminal `result` the CLI prints is treated as the outcome, and if no
exit follows within `AGENT_EXIT_GRACE_MS` the leftovers are killed and the run is closed out on the
strength of that result rather than left `active` indefinitely.

## Running several tasks at once

If a project directory is a git repo, each task gets **its own branch and its own checkout** (a
`git worktree`), so two agents can work the same repo simultaneously without tripping over each other.
Your own working copy is never touched while they run.

```
main ──┬── llm-task/12   (worktree: data/worktrees/p1-task-12)
       └── llm-task/13   (worktree: data/worktrees/p1-task-13)
```

When a task finishes, the app:

1. Commits everything in that task's worktree.
2. Merges the current base branch **into the task branch**, inside the worktree — so if two tasks
   changed the same lines, the conflict happens somewhere harmless.
3. On conflict, hands it straight back to the agent: *resolve this, keep both changes, run the tests.*
   There is no approval prompt — the agent is trusted to merge and verify.
4. Fast-forwards your branch onto the result. A fast-forward is the only merge your working copy ever
   sees, so it can't leave you with a conflicted tree, and git refuses outright rather than clobbering
   uncommitted work.
5. Deletes the worktree and the task branch.

If any of that fails, the task is marked `failed` and a comment tells you which `llm-task/<id>` branch
still holds the work — nothing is ever thrown away.

Projects that **aren't** git repos have nowhere to isolate to, so their tasks are queued and run one at
a time instead.

## Surviving a restart

Every agent process is recorded in the database before it starts — its pid, its worktree, its branch.
When the app starts up it walks that list and reattaches to any process still alive, so closing the app
doesn't orphan an agent you can no longer see or stop.

Reattachment is deliberately conservative. A restart severs the pipe carrying the agent's output, and
there is no way to get it back — so an adopted agent's progress notes are gone, and when it exits the
app cannot tell whether it succeeded. It commits whatever the agent left in the worktree, parks it on
the task branch, marks the task `failed`, and tells you where the work is. Nothing is thrown away, and
nothing is merged on a guess.

Runs whose process is gone are closed out, and any task still marked `active` with no agent behind it
goes back to `ready`. Pids get recycled, so a recorded pid is only adopted when the process at that pid
still has the executable name we started — otherwise the app would happily adopt, and later kill, a
stranger's process.

## Staying current

`GET /api/events` is a server-sent event stream. Whenever a row changes, the server pushes a frame
saying only *something moved* — never what — and the browser refetches what it has on screen. Because
the payload is meaningless, a duplicated, reordered or dropped frame cannot corrupt anything, which is
what keeps this to one small file with no dependencies.

The notification is fired from a single place: a wrapper around the prepared-statement `run()` in
`db.js`. Every write in the app goes through it, so a new query cannot quietly forget to notify.

The server also greets each new connection with a frame before sending any real ones. `EventSource`
reconnects on its own, and that greeting makes it resync — so a dropped stream needs no reasoning
about what was missed while it was down.

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `VIBE_WRANGLER_DB` | `./data/vibe_wrangler.db` | SQLite database file |
| `VIBE_WRANGLER_LOGS` | `./data/logs` | Directory for raw agent transcripts |
| `VIBE_WRANGLER_WORKTREES` | `./data/worktrees` | Where per-task git worktrees are checked out |
| `VIBE_WRANGLER_ATTACHMENTS` | `./data/attachments` | Where pasted and uploaded files are stored |
| `ATTACHMENT_MAX_BYTES` | `26214400` | Largest single upload accepted (25 MB) |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `AGENT_MODEL` | `claude-opus-5` | Passed to `claude --model` |
| `AGENT_EXIT_GRACE_MS` | `20000` | How long to wait for the CLI to exit after it reports its result |

The agent is invoked as:

```
claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model <AGENT_MODEL>
```

## Permissions (read this)

**The agent runs with `--dangerously-skip-permissions`.** Every action a Claude Code session would normally
stop and ask you to approve — editing files, deleting them, running builds, running arbitrary shell commands,
installing packages, making network requests — happens automatically, with no prompt and no undo.

This is not a setting you can turn off here; it is the premise of the tool. The whole point is that tasks run
unattended while you are doing something else, and there is no terminal attached for anyone to approve a
prompt on. An agent blocked on a confirmation nobody will ever answer is an agent that hangs forever.

What that means in practice:

- **Only point projects at directories you are willing to lose.** Treat every project directory as
  disposable — committed, pushed, and backed up somewhere the agent cannot reach.
- **The blast radius is not limited to the project directory.** The agent runs shell commands as *you*, with
  your user's permissions and your credentials. It can reach anything you can: other repos, your home
  directory, your cloud CLI sessions, the internet.
- **Task descriptions are instructions to a process that will act on them.** Anything the agent reads —
  a task description, a file in the repo, a web page it fetches, a dependency's README — can influence what
  it does next. Don't paste in text you haven't read from a source you don't trust.
- **Run it somewhere you can afford to be wrong.** A VM, a container, or a dedicated machine is a far better
  home for this than your primary workstation.

Git isolation ([above](#running-several-tasks-at-once)) protects your *working copy* from concurrent agents.
It is not a security boundary and does nothing to contain a command the agent chooses to run.

## Project layout

```
server.js          HTTP server + JSON API
db.js              SQLite schema and queries
agent.js           Spawns the agent CLI, parses its output into comments (the CLI-specific seam)
git.js             Worktree / branch / merge plumbing for concurrent tasks
proc.js            Liveness, identity and tree-kill for agent processes
events.js          Server-sent change notifications that keep open tabs current
public/            Single-page front end (no build step, no framework)
test/smoke.js      End-to-end API test against a throwaway database
test/worktree.js   Two-agents-one-repo concurrency and merge-conflict test
data/              SQLite database, raw agent logs, task worktrees (git-ignored)
run.bat            Start the app on Windows
run.sh             Start the app on macOS / Linux
```

## Tests

```sh
npm test
```

Two suites, neither of which invokes the real Claude CLI — both are fast and free.

- `test/smoke.js` spins the server up on a spare port against a temporary database and exercises the
  whole API: CRUD, tags, status filtering, cascade deletes, and the agent's failure paths.
- `test/worktree.js` builds throwaway git repos and runs two agents on one repo at the same time,
  using a scripted stand-in for the CLI. It checks that both changes land, that a genuine merge
  conflict is resolved without losing either side, that non-git projects fall back to a queue, and
  that a failed run leaves your checkout clean.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects` | List projects with task counts |
| `POST` | `/api/projects` | Create a project |
| `PUT` | `/api/projects/:id` | Update a project |
| `DELETE` | `/api/projects/:id` | Delete a project and its tasks |
| `GET` | `/api/projects/:id/tasks?status=&tag=` | List a project's tasks, optionally filtered |
| `GET` | `/api/tasks?status=&tag=` | List tasks across every project |
| `GET` | `/api/tags` | Every tag in use, with task counts |
| `GET` | `/api/quick-tags` | The tag set offered on a task's right-click menu |
| `POST` | `/api/quick-tags` | Add a tag to that set |
| `POST` | `/api/projects/:id/tasks` | Create a task |
| `GET` | `/api/tasks/:id` | Task detail with comments |
| `PUT` | `/api/tasks/:id` | Update a task |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `POST` | `/api/tasks/:id/comments` | Add a comment |
| `DELETE` | `/api/comments/:id` | Delete a comment |
| `POST` | `/api/attachments` | Upload a file — the body is the file, the name rides in `X-Filename` |
| `GET` | `/attachments/:file` | Serve an uploaded file back |
| `POST` | `/api/tasks/:id/run` | Hand the task to the agent |
| `POST` | `/api/tasks/:id/stop` | Stop a running agent |
| `POST` | `/api/projects/:id/run-ready` | Run every `ready` task in the project |
| `POST` | `/api/projects/:id/run-failed` | Retry every `failed` task in the project |
| `GET` | `/api/agents` | Every agent process the app knows is running |
| `POST` | `/api/agents/:id/stop` | Terminate one of them |
| `GET` | `/api/tasks/:id/log` | Raw transcript of the last agent run |
| `GET` | `/api/statuses` | Known status values (built-in + user-defined) |
| `GET` | `/api/events` | Change notification stream (server-sent events) |

## License

MIT — see [LICENSE](LICENSE).
