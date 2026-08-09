# llm_tasks

A lightweight web app for managing **projects** and **tasks** that a **Claude Code agent** works on for you.

The point: you keep a clean, human-readable board of work. The agent picks up tasks, does the work, and
reports back in short, user-level comments — you never have to wade through tool calls, diffs, or token noise
unless you actually want to.

```
Projects  ──▶  Tasks  ──▶  Comments
                 │             ▲
                 └── agent ────┘
```

## Features

- **Projects** — create / edit / delete. Each project points at a working directory on disk (that's where the agent runs).
- **Tasks** — create / edit / delete, grouped and filterable by status.
- **Tags** — label tasks with anything you like (`bug`, `backend`, `v2`). Tags are normalized (trimmed,
  lower-cased, de-duplicated) so `Backend` and `backend ` are the same tag.
- **All tasks view** — one board showing every task across every project, filterable by tag *and* status.
  Useful for "show me everything tagged `release` no matter which repo it lives in".
- **Statuses**
  - `ready` — queued for the agent to pick up
  - `active` — the agent is working on it right now
  - `completed` — the agent finished
  - **anything else** (`blocked`, `on hold`, `idea`, …) — user-defined; the agent ignores these
- **Comments** — an append-only conversation per task. The agent writes progress notes while it works and a
  summary when it finishes. You can add your own comments too (review notes, test results, follow-ups).
- **Raw logs** — the full technical transcript of each agent run is saved to disk and linked from the task,
  so it's there when you need it and out of the way when you don't.
- **Local & private** — everything lives in a single SQLite file. No cloud, no API keys.

## Why the Claude CLI (not the API)

The agent is invoked by shelling out to the `claude` CLI in non-interactive (`-p`) mode. That means it uses
**your existing Claude subscription login** — there is no `ANTHROPIC_API_KEY` to manage and no per-token billing.

## Requirements

- **Node.js 22+** (uses the built-in `node:sqlite` module — no `npm install`, zero dependencies)
- **Claude Code CLI** on your `PATH`, already logged in (`claude` → `/login`)

## Quick start

```bat
run.bat
```

Then open <http://localhost:3000>.

`run.bat` starts the server and opens your browser. To use a different port:

```bat
set PORT=4000 && run.bat
```

On macOS / Linux:

```sh
node server.js
```

## How a task gets worked

1. You create a project pointing at a repo directory.
2. You add a task with a title and a description of what you want done.
3. Set the task to **ready** and hit **Run** (or **Run all ready** on the project).
4. The app flips the task to **active** and launches:
   `claude -p "<task prompt>" --output-format stream-json` in the project directory.
5. While it works, any line the agent emits starting with `NOTE:` is captured as a **user-level comment**.
6. When it's done, the final summary is saved as a comment and the task flips to **completed** (or back to
   `ready` with an error comment if the run failed).

You then review the comments, test the change, and either close it out or add a follow-up task.

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

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `LLM_TASKS_DB` | `./data/llm_tasks.db` | SQLite database file |
| `LLM_TASKS_LOGS` | `./data/logs` | Directory for raw agent transcripts |
| `LLM_TASKS_WORKTREES` | `./data/worktrees` | Where per-task git worktrees are checked out |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `AGENT_MODEL` | `claude-opus-5` | Passed to `claude --model` |

The agent is invoked as:

```
claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model <AGENT_MODEL>
```

> **Note on permissions:** the agent runs with `--dangerously-skip-permissions` so it can edit files, run
> builds, and run tests without a human at the keyboard — there is no terminal attached to approve prompts.
> Only point projects at directories you're willing to let it change.

## Project layout

```
server.js          HTTP server + JSON API
db.js              SQLite schema and queries
agent.js           Spawns the Claude CLI, parses its output into comments
git.js             Worktree / branch / merge plumbing for concurrent tasks
public/            Single-page front end (no build step, no framework)
test/smoke.js      End-to-end API test against a throwaway database
test/worktree.js   Two-agents-one-repo concurrency and merge-conflict test
data/              SQLite database, raw agent logs, task worktrees (git-ignored)
run.bat            Start the app on Windows
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
| `POST` | `/api/projects/:id/tasks` | Create a task |
| `GET` | `/api/tasks/:id` | Task detail with comments |
| `PUT` | `/api/tasks/:id` | Update a task |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `POST` | `/api/tasks/:id/comments` | Add a comment |
| `DELETE` | `/api/comments/:id` | Delete a comment |
| `POST` | `/api/tasks/:id/run` | Hand the task to the agent |
| `POST` | `/api/tasks/:id/stop` | Stop a running agent |
| `POST` | `/api/projects/:id/run-ready` | Run every `ready` task in the project |
| `GET` | `/api/tasks/:id/log` | Raw transcript of the last agent run |
| `GET` | `/api/statuses` | Known status values (built-in + user-defined) |

## License

MIT
