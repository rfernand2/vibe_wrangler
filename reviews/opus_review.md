# Vibe Wrangler — a review

**★★★★☆ — 4 / 5**

*Reviewed 15 August 2026, against commit `d0a1ae7`. Reviewer: Claude Opus 5.*

> **One-line verdict:** An unusually well-built small tool with one genuinely original idea — agents
> that report in plain English instead of a terminal firehose — held back from five stars by an
> unauthenticated network surface and a merge-straight-to-main default that trusts the agent further
> than most people will want to.

---

## What it is

Vibe Wrangler is a local web app that turns a project-and-task board into a work queue for coding-agent
CLIs. You point a project at a directory, write a task, press **Run**, and the app shells out to
Claude Code, OpenAI Codex or Grok Build in a private git worktree. The agent works unattended; the board
fills up with short progress notes and a ticking checklist; when it finishes, the work is committed,
merged back into your branch, and pushed.

It is roughly 8,200 lines of JavaScript — about 3,500 of application code, 1,700 of front end, 1,600 of
tests — with **zero npm dependencies**. Node 22's built-in `node:sqlite` is the database, `node:http`
is the server, and the front end is hand-written DOM with no framework and no build step. `git clone`
and `node server.js` is the whole install.

---

## The good

### 1. The reporting protocol is the actual product

Every competitor in this space shows you the agent's terminal. Vibe Wrangler deliberately throws the
terminal away and keeps three prefixes:

| The agent writes | The board shows |
| --- | --- |
| `NOTE: <sentence>` | a plain-language comment on the task |
| `PLAN: <sub-task>` | a new checklist item |
| `DONE: <sub-task>` | that item, ticked |

Everything else is dropped (though the raw transcript is still saved to disk and one click away). The
result is a board a non-technical person can read: not "active", but *"3 of 5 done, and here is what it
found."* This is the thing the app does that nothing else in the category does, and it is the right
call — the raw stream of an agent run is mostly noise, and reading it is the cost the tool is supposed
to remove.

The implementation is more careful than the idea needs. `DONE:` matches on words rather than exact
text, so an agent rewording an item slightly still ticks the right box. And in `harnesses.js` there is a
regex boundary (`DIRECTIVE_BOUNDARY`) that splits on a newline *or* a lookahead at the next directive,
because models run one directive onto the end of the last — `…in the project.NOTE: Found the…`. The
comment explains why it exists: without it, one five-minute run narrated six times and the human saw all
six in the final second. That is a bug you only find by using the thing.

### 2. The git plumbing is genuinely careful

The merge-back path (`agent.js:mergeBack`, `git.js`) makes a decision most tools get wrong. Rather than
merging the task branch into your checkout, it merges *base into the task branch, inside the worktree* —
so if there's a conflict, it happens somewhere disposable — and then only ever **fast-forwards** your
real checkout. A fast-forward is the one merge git will refuse rather than perform badly, so the app
structurally cannot leave you with a conflicted tree or clobber uncommitted work. That's a good
invariant, chosen on purpose, and stated as such in the comments.

Around it:

- `pickTaskBranch` steps aside to `-retry2` rather than deleting a branch that still holds unmerged
  commits, so a retry can't destroy the failed attempt's work.
- Every git call goes through one `spawnSync` with an **argv array, never a shell string**, with
  `GIT_TERMINAL_PROMPT=0` so a missing credential helper fails instead of hanging forever on a password
  prompt nobody will type.
- Failure always parks the work on a named branch and tells you which one. Nothing is thrown away.

### 3. Process supervision that assumes the worst

`proc.js` is 58 lines and every one of them is earned. Agent pids are recorded in SQLite *before* the
process starts, so a restart can reattach. Critically, an orphan is only adopted if the process at that
pid still has the executable name we launched — because pids get recycled, and the alternative is an app
that cheerfully adopts and later kills a stranger's process. On Windows it kills the process *tree*,
because the CLI sits under a shell shim and signalling the child alone leaks it.

Reattachment is also honestly conservative: a restart severs the output pipe and it cannot be recovered,
so an adopted agent's work is committed, parked, and marked `failed` rather than merged on a guess. The
README says so plainly. Tools usually paper over this.

### 4. The harness abstraction actually holds

`harnesses.js` is one 366-line file, and it contains everything that differs between the three CLIs:
the flags, whether the prompt arrives on stdin or in a file, which env vars to strip, and how to read
that vendor's JSON event stream down to two facts (*assistant text*, *run over*). `agent.js` never
learns which CLI it is driving. The README's claim that adding a fourth is "an entry in that list and
nothing else" is supported by the code.

Two details worth singling out. Each harness deletes its vendor's API-key variables from the child
environment, so the CLI is forced onto your **subscription login** rather than silently billing per
token off an inherited key — a real money bug, pre-empted. And Grok's `preflight` refuses a run with a
missing OpenRouter key or an unpulled Ollama model *before* a worktree and branch are created, so you
get "run `ollama pull qwen3-coder`" instead of a bare `401` from someone else's server four minutes in.

### 5. The tests are real tests

Two suites, 41+ named checks, no real agent CLI involved (a scripted stand-in plays the part), so they
are fast and free. `test/worktree.js` builds throwaway repos and runs **two agents on one repo at the
same time**, then asserts that both changes land, that a genuine merge conflict is resolved without
losing either side, that a failed run leaves the main checkout clean, and that a retry doesn't delete
the earlier attempt's branch. Concurrency and merge semantics are exactly the parts that break in the
field, and they are the parts under test. Both suites pass on this commit.

### 6. Comments that explain *why*

This deserves its own heading because it is rare. The codebase almost never explains what a line does;
it explains the decision behind it, usually including the alternative that was rejected. Ollama's model
list isn't hardcoded because "any list written here is a guess that is wrong on every machine that
didn't make the same choices," and a failed lookup keeps the last known list because "a stopped server
is not the same as nothing installed, and emptying the dropdown would be its own kind of lie." An
existing Grok config alias is left alone rather than overwritten because it "may have been tuned by
hand." That is the writing of someone who had to make the call and wanted the next reader to inherit the
reasoning rather than re-derive it.

### 7. A few smart small things

- **Change notifications carry no payload.** The SSE frame says only *something moved*; the browser
  refetches. A duplicated, reordered or dropped frame therefore cannot corrupt anything — which is what
  keeps the live-update layer to 55 lines with no dependencies. The notification fires from a single
  wrapper around the prepared-statement `run()` in `db.js`, so a new query cannot forget to notify.
- **Random harness + grading + performance chart.** A tickbox deals each new task a harness by lot,
  pinned to the task so a retry runs the same one. Grade the results and the chart is a like-for-like
  comparison of Claude vs Codex vs Grok *on your own codebase*. I have not seen this anywhere else, and
  for anyone actually trying to decide which CLI to pay for, it is the most useful feature here.
- **Plan-and-stop recovery.** A run that reports nothing at all is handed its own plan back and asked to
  carry it out, once. This works around a real failure mode (Grok's loop ends on any message without a
  tool call) without pretending a prompt tweak fixed it — the README links the upstream issue and quotes
  the actual hit rate.
- **Uploads are served with `nosniff` and a `default-src 'none'; sandbox` CSP**, so an uploaded SVG or
  HTML file can't run script on the app's origin. The front end builds DOM with `textContent`
  throughout, so task titles and comments are not an injection vector.

---

## The bad

### 1. No authentication, and it binds every interface

`server.js:441` is `server.listen(PORT, …)` with no host argument, so Node binds `0.0.0.0`. There is no
login, no token, no origin check, and no CSRF protection on any of the mutating endpoints. The API can
create a project pointing at **any directory on disk** and run an agent in it with approvals disabled.

That is remote code execution as *you*, available to anything that can reach the port — every device on
the coffee-shop Wi-Fi, and any website you happen to be visiting, since a plain HTML form can POST
JSON-ish bodies cross-origin without a preflight.

The README's security section is admirably direct about the *agent's* blast radius, but it frames the
risk as "the agent might do something you didn't want" rather than "someone else might drive it." For a
tool whose entire premise is unattended execution, `server.listen(PORT, '127.0.0.1')` is a one-line
change that would close the largest hole in the product. **This is the single thing I would fix first.**

### 2. Merging to main and pushing, with no review gate

On success the app commits, merges into your base branch, fast-forwards your checkout, and then —
`agent.js:pushToGithub` — **pushes to `origin` automatically**. On a merge conflict it hands the
conflict back to the agent to resolve, and the README is explicit: "there is no approval prompt — the
agent is trusted to merge and verify."

This is a coherent philosophy and it is the opposite of nearly every competitor, which stop at "here is
a diff, review it." For a solo developer on their own side projects — which is transparently what this
was built for — it is the right trade. For anyone else it is alarming, and it isn't configurable: there
is no `--require-review` mode, no "merge but don't push," no staging of completed work for approval.
Given how much of the rest of the app is about *not* losing work, one setting to hold changes on their
branch until a human says so would widen the audience considerably at very little cost.

### 3. Three harnesses, in a market that's counting to eleven

The abstraction is good, but the catalogue is small. Competitors ship 11 CLIs (Kanbots) or a long list
including Cursor, Gemini, Copilot and Amp (Vibe Kanban). Adding Aider, Gemini CLI or an ACP-compatible
CLI looks like an afternoon's work given the design, and not having done it is the most visible gap on a
feature comparison. Relatedly, the model catalogue is hardcoded and only refreshed at restart, and
`usage.js` carries hand-maintained "August 2026 list prices" that will quietly go stale.

### 4. Rough edges around the outside

- **The README documents the wrong port.** It says the default is `3000` and that the launcher opens
  `localhost:3000`; `run.bat` and `run.sh` both default to **5000** (deliberately, per their own
  comments — 3000 was reassigned to another app). A first-time reader following the Quick start looks at
  the wrong URL. Trivial to fix, and worth fixing precisely because the rest of the documentation is so
  reliable.
- **Both launchers only check for `claude`**, warning that "the agent will not be able to start" even if
  you have Codex and Grok installed and intend to use them.
- **No CI, no linter, no `.github/` at all.** The tests are good, fast, free and nothing runs them.
- **No pagination or search.** Every task list query is unbounded, and the "All tasks" view fetches
  everything across every project. Fine at a few hundred tasks; the board will get heavy well before
  SQLite does.
- **The non-git queue is in memory**, so restarting the app silently drops anything waiting. The README
  says so, which helps, but the queue could live in the database as easily as not.
- **Single user by construction.** No accounts, no per-user filtering, one Settings row for the machine.
  Reasonable for what it is — just don't expect it to survive contact with a second person.

### 5. It is one week old

First commit 8 August 2026; 67 commits total, largely written by the agents it drives. That is a
remarkable amount of working software for a week and it explains the codebase's coherence — but there
is no soak time behind it. Nothing here has survived a month of real use, an upstream CLI changing its
JSON event format, or a repository large enough to make the merge path interesting.

---

## Against the competition

Git worktrees became load-bearing for AI coding in early 2026, and a crowded field appeared almost
overnight. Vibe Wrangler is a late entrant to a category that already has a shakeout behind it — Bloop,
the company behind Vibe Kanban, announced its shutdown in April 2026 and the project continues
community-maintained.

| | **Vibe Wrangler** | **Vibe Kanban** | **Cline Kanban** | **Conductor** | **Nimbalyst** (ex-Crystal) | **Claude Squad** |
| --- | --- | --- | --- | --- | --- | --- |
| Form | Local web app | CLI + web UI | Local web app | macOS desktop app | Desktop app | Terminal (tmux) |
| Agents | 3 | Many (Claude, Cursor, Copilot, Gemini…) | Claude, Codex, Cline | Claude Code, Codex | Claude Code | Claude, Codex, Aider, Gemini |
| Worktree isolation | ✅ | ✅ | ✅ | ✅ | ✅ optional | ✅ |
| Install weight | **Zero deps, no build** | `npx` | `npx` | App download | App download | Go binary + tmux |
| Progress view | **Plain-English notes + checklist** | Board + diff review | Per-card terminal | Per-agent panes | Board + diffs | Terminal panes |
| Merge policy | **Auto-merge + auto-push** | PR-style review | Review | Review | Review | Manual |
| Harness A/B + grading | **✅** | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cost/usage reporting | **✅** | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cross-platform | ✅ | ✅ | ✅ | ❌ macOS only | ✅ | ✅ (Unix-ish) |
| Auth on the UI | ❌ | ❌ (localhost) | ❌ (localhost) | n/a | n/a | n/a |

**Where Vibe Wrangler wins.** Three places, clearly:

1. **Installation and footprint.** No dependencies, no build step, no Electron, one SQLite file. Against
   an `npx` package pulling a tree of transitive dependencies — or a 200 MB desktop app — this is a
   materially different thing to trust on a machine, and a materially different thing to audit. You can
   read the entire application in an afternoon.
2. **Legibility.** Everyone else's answer to "how's it going?" is a terminal. Vibe Wrangler's is a
   sentence and a half-ticked checklist. If you are running several tasks while doing something else —
   which is the whole premise — that difference compounds every time you glance at the screen.
3. **The A/B harness draw, grading and usage report.** Nothing else in the field helps you answer *which
   of these CLIs is actually better on my code, and what is it costing me?* Nobody else is even asking.

**Where it loses.** Also three:

1. **Review workflow.** Vibe Kanban, Conductor and Nimbalyst are built around inspecting a diff before
   it lands. Vibe Wrangler merges and pushes. For team use, or any repository with a branch policy,
   that is disqualifying on its own.
2. **Breadth.** Three agents against eleven; no MCP wiring, no IDE integration, no PR creation.
3. **Polish and community.** Competitors are backed apps with issue trackers, releases and users. This
   is one person's tool with 67 commits and no CI. Being better-commented than a funded product doesn't
   substitute for having been run by a thousand people.

**Not really competitors,** despite showing up in the same searches: Devin, Google Jules, Cursor
background agents and GitHub's Copilot coding agent are cloud-hosted services that run *their* agent on
*their* infrastructure against your repo. Vibe Wrangler runs *your* CLI on *your* subscription on *your*
machine, against directories that never leave it. Different product, different privacy posture,
different bill — the fact that it uses your existing flat-rate CLI login rather than metered API keys is
a real and deliberate cost advantage worth stating plainly.

---

## Who should use this

**Yes, if:** you're a solo developer running several agent tasks a day across your own repositories, you
already pay for Claude Code / Codex / Grok, you want to glance at a board rather than babysit terminals,
and you're comfortable with an agent merging to main on your say-so-in-advance. Run it on a machine you
can afford to be wrong on. It will feel better than anything else in this list for exactly that job.

**No, if:** you need review-before-merge, you work on a team or a shared repo, you need an agent this
doesn't support, or you'd be running it anywhere its port is reachable by someone else.

---

## What I'd fix, in order

1. **Bind to `127.0.0.1` by default** (`server.js:441`), with an explicit opt-in env var for anything
   wider. One line; closes the biggest hole in the product.
2. **Add a "hold for review" setting** — merge to the task branch, stop, and let a human press the
   button. Keeps the current behaviour as the default if you like; just make it a choice.
3. **Fix the port in the README** and make the launchers check for whichever CLI is actually configured.
4. **Add a CI workflow.** The tests are good, fast and free; nothing runs them.
5. **Persist the non-git queue** so a restart doesn't silently drop queued work.
6. **Add two or three more harnesses.** The abstraction is ready and the gap is the most visible thing
   on any comparison table.

---

## Verdict

**★★★★☆ (4/5).** The craft here is well above what the size of the thing suggests — the git isolation
is thought through to its invariants, the process supervision assumes pids get recycled and pipes get
severed, the comments explain decisions rather than syntax, and the concurrency tests test the parts
that actually break. The plain-English reporting protocol is a real idea, well executed, and the
harness A/B comparison is something nobody else offers.

It falls short of five for reasons that are fixable rather than fundamental: an unauthenticated server
listening on every interface in front of a deliberate arbitrary-code-execution engine, an
auto-merge-and-push default with no review option for those who want one, a thin harness catalogue in a
field that got crowded fast, and a week of age. Fix the first two and this is a five-star tool for its
intended user — who, to be fair, appears to already be using it every day, and built most of it with
itself.

---

### Sources for the competitive comparison

- [Best Tools for Managing Parallel AI Coding Agents in 2026 — Nimbalyst](https://nimbalyst.com/blog/best-agent-management-tools-2026/)
- [Best Git Worktree Tools for AI Coding in 2026 — Nimbalyst](https://nimbalyst.com/blog/best-git-worktree-tools-ai-coding-2026/)
- [9 Open-Source Agent Orchestrators for AI Coding (2026) — Augment Code](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- [Vibe Kanban — Orchestrate AI Coding Agents](https://www.vibekanban.com/)
- [Cline debuts Kanban for local parallel CLI coding agents — TestingCatalog](https://www.testingcatalog.com/cline-debuts-kanban-for-local-parallel-cli-coding-agents/)
- [Cline CLI — Coding Agents in Your Terminal and on a Kanban Board](https://cline.bot/cli)
- [kanbots — local kanban board for agent CLIs](https://github.com/leodavinci1/kanbots)
- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [The Best Tools to Run Multiple Coding Agents in 2026 — agentsroom.dev](https://agentsroom.dev/blog/best-multi-agent-coding-tools)
- [vibe-kanban alternatives for AI coding agents (2026) — aq.dev](https://aq.dev/alternatives/vibe-kanban/)
