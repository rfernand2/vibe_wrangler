# Vibe Wrangler — Grok review

**Rating: ★★★★☆ (4 / 5)**  
**Reviewed:** 15 August 2026

> A small, local control room for coding-agent CLIs. It does not try to be another chat window.
> It tries to be a backlog you can leave running. On that job it is unusually good. It is not
> a five-star product yet, because it trusts the network and the agent more than most people
> should, and because its Grok path is still bumpier than the Claude and Codex ones.

---

## What it is

Vibe Wrangler is a single-user web app that sits on your machine, points at directories you
already have, and hands work to **Claude Code**, **OpenAI Codex**, or **Grok Build**. You write a
task. You press Run. The app opens a private git checkout for that task, starts the CLI with
approvals turned off, and turns three kinds of line — `NOTE:`, `PLAN:`, `DONE:` — into a
human-readable thread and a ticking checklist. When the agent finishes, the change is committed,
merged back, and (if there is an `origin`) pushed.

There are no npm packages. Node 22's built-in SQLite and HTTP server do the work. The front end
is plain files. Clone it, run `run.bat` or `run.sh`, open the board. That lightness is not a
marketing line; it is the whole install.

I reviewed the code, the board screenshot, the README, and the test suite (145 checks, all
passing). I also used the product the way it is meant to be used: as a Grok Build agent, on a
task it queued for itself. That last part matters, because two of the product's own earlier
attempts at this review never started.

---

## What works

### A board a person can actually glance at

Most tools in this category answer "how's it going?" with a terminal. Vibe Wrangler throws the
terminal away on purpose. The agent is told, in the prompt itself, that a human will only read
the short notes, and that a sentence without a `NOTE:` prefix is discarded unread. The noisy
transcript is still one click away. The thing you look at while making coffee is a sentence and
a half-ticked list.

That is the product. Everything else is in service of it. The matching of `DONE:` on words rather
than exact text, the split that still catches a directive glued onto the previous sentence, the
rule that a run which only planned and then stopped is handed its plan back once — those are
details you only write after watching real runs fail in front of a person.

The board itself is dense and readable. Projects on the left, tasks in the middle, status pills,
tags, a live timer, checklist progress. Dark chrome, visible button targets, no framework chrome
getting in the way. It looks like a tool someone uses every day, because it is.

### Git isolation that has thought about the failure cases

Each task in a git repo gets its own worktree and branch. Two agents can edit the same project
at once without sharing a checkout. When a task finishes, the app merges *the base branch into
the task branch* — so a conflict happens somewhere disposable — and only ever fast-forwards your
real working copy. Git will refuse a fast-forward rather than do it badly, which means the app
structurally cannot leave you with a conflicted tree or overwrite uncommitted work.

Failed work is parked on a named branch. A retry steps aside to `-retry2` instead of deleting
the earlier attempt. Process records are written *before* the CLI starts, and a leftover pid is
only adopted if the process at that pid still has the same executable name — because pids get
recycled, and adopting a stranger's process would be worse than losing track of your own. After
a restart the output pipe is gone, so adopted work is committed, parked, and marked failed
rather than merged on a guess. The README says this plainly. Most tools paper over it.

The tests cover the parts that actually break: two agents on one repo, a genuine merge conflict
that keeps both sides, a failed run that leaves main clean, a retry that does not destroy the
first attempt, a comment that reopens a finished task without resetting the clock.

### Three harnesses, one file, and a fair comparison

Everything that differs between Claude, Codex and Grok lives in one catalogue: flags, how the
prompt arrives, which environment variables to strip, how to read that vendor's JSON stream.
Adding a fourth is supposed to be an entry in that list. The code supports the claim.

Two choices here are smarter than they look. Native Claude and Codex have their API keys
deleted from the child environment, so they are forced onto the subscription login you already
pay for instead of silently billing per token. And a Settings tickbox deals each new task a
harness at random, pinned so a retry runs the same one. Grade the results and the performance
chart is a like-for-like comparison of the three CLIs *on your own code*. I have not seen that
anywhere else. For anyone trying to decide which subscription is actually earning its keep, it
is the most useful feature in the app.

Usage reporting splits the two cost channels: subscription rows show what the same tokens
would have billed on the API; metered rows (OpenRouter, native Grok) show what you actually
paid. Attachments, custom statuses, cross-project tag filters, live server-sent updates, and
project-level Run local / Push / Deploy buttons make the board useful past the happy path.

### Honesty in the comments and the docs

The codebase almost never explains what a line does. It explains the decision, including the
alternative that was rejected. Ollama's model list is not hardcoded because any list written
here would be wrong on every machine that made different choices. A failed lookup keeps the
last known list because a stopped server is not the same as nothing installed. An existing
Grok config alias is left alone because it may have been tuned by hand. That is rare, and it
is why a stranger can read this in an afternoon and trust the reasoning.

The security section of the README is similarly direct about the *agent*: approvals are off,
the blast radius is your whole user account, run this on a machine you can afford to be wrong
on. That warning is earned.

---

## What does not

### The server is an unauthenticated remote-control for your user account

`server.listen(PORT)` binds every interface. There is no login, no token, no origin check.
The API can point a project at any directory on disk and start an agent there with approvals
disabled. That is remote code execution as *you*, available to anything that can reach the
port — another device on the same Wi-Fi, and in some cases a web page you have open.

The README is excellent about what the *agent* might do. It is quieter about what *someone
else* might do with the board. For a tool whose premise is unattended execution,
`127.0.0.1` by default is a one-line change that would close the largest hole in the product.
This is the first thing I would fix.

### Merge and push with no review gate

On success the app commits, fast-forwards your branch, and pushes to `origin`. On conflict it
hands the conflict back to the agent. There is no "hold for review," no "merge but don't
push," no pull request. The philosophy is coherent — this is a solo-developer tool that
assumes you meant it when you pressed Run — and it is the opposite of nearly every competitor.

For side projects on a machine you own, it is the right default. For a shared repo, a branch
policy, or anyone who wants to see a diff first, it is disqualifying, and it is not a setting.

### The Grok path is the weakest of the three

I am writing this as a Grok Build agent that the board itself launched. Two earlier attempts
at this same review never produced a word.

The first died because the catalogue's default model, **Grok 4.6**, was rejected by the CLI as
an unknown model id. The dropdown offered it; the binary did not know it. That is exactly the
class of failure the app's preflight is supposed to catch for OpenRouter and Ollama — a bad
choice stopped *before* a worktree is made — and it is not caught for the native Grok list.

The next attempts died on the free Grok Build quota. The code even comments on this: stripping
the xAI API key (the way Claude and Codex strip theirs, to force the subscription login) made
4.6 unknown or capped as free, so the key is now left in place. The result is a harness that
sometimes needs a paid key, sometimes hits a free-tier wall, and sometimes cannot start the
model the UI just offered. Claude and Codex ride a flat login and just work. Grok still needs
a human to know which of those three states they are in.

Grok is also the harness that ends a run on any message with no tool call, which is why the
plan-and-stop retry exists. That recovery is well done. It should not have to be load-bearing.

Related small cuts: the README still says the default port is 3000 and that the launcher opens
`localhost:3000`. Both launch scripts default to **5000**, on purpose. A first-time reader
following Quick start looks at the wrong URL. The launchers also only check for `claude`, and
warn that "the agent will not be able to start" even if Codex or Grok is the one you intend
to use.

### Thin in the ways a week-old tool is thin

First commit 8 August 2026. No CI, no linter, no issue tracker of any size. Three harnesses in
a field that already counts past ten. No pagination or search — the All-tasks view fetches
everything. The non-git queue lives in memory, so a restart silently drops anything waiting.
Price tables in the usage report are a hand-maintained August 2026 list. None of this is
surprising. It is just the difference between a carefully built personal tool and a product
other people can depend on.

---

## Against the competition

Git worktrees became the standard way to run several coding agents at once in 2026, and a
crowd of tools appeared almost overnight. Vibe Wrangler is a late, small, opinionated entry.

| | **Vibe Wrangler** | **Vibe Kanban** | **Cline Kanban** | **Conductor** | **Nimbalyst** | **Claude Squad** | **OpenHands** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Form | Local web app | CLI + web UI | Local web app | macOS app | Desktop app | Terminal (tmux) | Local / cloud platform |
| Agents | 3 (Claude, Codex, Grok) | Many, including Cursor, Copilot, Gemini | Claude, Codex, Cline | Claude Code, Codex | Claude Code | Claude, Codex, Aider, Gemini | Its own runtime |
| Isolation | Worktrees | Worktrees | Worktrees | Worktrees | Optional worktrees | Worktrees / tmux | Sandboxed workspaces |
| Install | **Zero deps, no build** | `npx` | `npx` | App download | App download | Go binary + tmux | Heavier stack |
| Progress | **Notes + checklist** | Board + diffs | Per-card terminal | Per-agent panes | Board + diffs | Terminal panes | Session / canvas |
| Merge | **Auto-merge + push** | Review / PR | Review | Review | Review | Manual | Configurable |
| A/B + grades | **Yes** | No | No | No | No | No | No |
| Usage / cost | **Yes** | No | No | No | No | No | Partial |
| Auth on the UI | **No** (binds all interfaces) | No (typically localhost) | No (typically localhost) | n/a | n/a | n/a | Yes, in hosted form |

**Where Vibe Wrangler wins**

1. **You can read the whole thing.** No dependency tree, no Electron, one SQLite file. Against
   an `npx` install or a 200 MB desktop app, that is a different thing to trust and a different
   thing to audit.
2. **Legibility.** Everyone else shows you a terminal. This shows you a sentence. If you are
   running several tasks while doing something else — the whole premise — that difference
   compounds every time you look up.
3. **Choosing a CLI with evidence.** Random assignment, grading, a performance chart, and a
   usage report that separates subscription from metered spend. Nobody else is even asking
   "which of these is better on *my* repo, and what is it costing me?"

**Where it loses**

1. **Review.** Vibe Kanban, Conductor and Nimbalyst are built around inspecting a diff before
   it lands. Vibe Wrangler merges and pushes. For team use that is the end of the conversation.
2. **Breadth.** Three agents against a long tail. No MCP wiring, no IDE plugin, no PR creation.
3. **Safety defaults.** Competitors that ship a local web UI tend to assume localhost. This one
   listens on every interface in front of a deliberate no-approvals agent. Conductor and the
   desktop apps avoid the question by not being a network service. OpenHands answers it with
   sandboxes and (in hosted form) accounts.
4. **Maturity.** Those products have users, releases, and scar tissue. This has a week of
   commits, many of them written by the agents it drives.

Cloud agents — Devin, Jules, Cursor background agents, Copilot coding agent — are a different
product. They run *their* agent on *their* machines against a repo you give them. Vibe Wrangler
runs *your* CLI, on *your* subscription, on *your* disk. Different privacy, different bill,
different blast radius. The fact that Claude and Codex use the login you already have, rather
than a metered API key, is a real cost advantage and should be said plainly.

---

## Who should use it

**Yes, if** you are a solo developer running several agent tasks a day across your own
repositories, you already pay for at least one of the three CLIs, you want to glance at a
board rather than babysit terminals, and you are comfortable with an agent merging to main
because you said so in advance. Run it on a machine you can afford to be wrong on. For that
job it will feel better than anything else on this list.

**No, if** you need to see a diff before it lands, you work on a team or a protected branch,
you need an agent this does not support, or the port would be reachable by anyone else.

If your main CLI is Grok Build, try a short task first and confirm the model the dropdown
offers is one `grok models` actually lists, and that you are not on a spent free quota. The
board will not save you from either of those.

---

## What I would fix, in order

1. **Bind to localhost by default**, with an explicit opt-in if you really want it on the LAN.
2. **Add a hold-for-review setting.** Keep auto-merge as the default if you like; just make
   "leave it on the task branch until I say so" a choice.
3. **Preflight the native Grok model** the same way OpenRouter and Ollama are preflighted, so
   "unknown model id" is a comment on the task, not a crashed run. Keep the catalogue in sync
   with `grok models`.
4. **Fix the port in the README** and make the launchers check for whichever CLI is actually
   configured, not only `claude`.
5. **Add a CI workflow.** The tests are good, fast, and free. Nothing runs them.
6. **Persist the non-git queue** so a restart does not silently drop waiting work.

---

## Verdict

**4 out of 5.** The craft is well above what the size and age suggest. The git isolation is
thought through to its invariants. The process supervision assumes pipes get severed and pids
get reused. The comments explain decisions. The tests cover concurrency and merge semantics,
not just CRUD. The plain-English reporting protocol is a real idea, well executed, and the
harness A/B comparison is something the rest of the field has not bothered to build.

It misses a fifth star for reasons that are fixable: an open network socket in front of an
unattended code-execution engine, an auto-merge-and-push default with no review option, a
Grok integration that still surprises you with unknown models and quota walls, and one week
of age. Fix the first two and this is a five-star tool for the person it was built for —
who, to be fair, appears to already be using it every day, and built a lot of it with itself.

I am one of the agents on that board. The notes above are the ones I would want the human to
read. The rest is in the raw log, if anyone wants it.
