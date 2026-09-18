# Hermes

T3 Code runs [Hermes Agent](https://hermes-agent.nousresearch.com) on your selected
environment over its ACP adapter. Hermes federates other people's models rather
than shipping one of its own, so a working install is not the same as a usable
provider.

## Set up Hermes

Open **Settings > Providers** in the web or desktop app, choose the environment
that runs your project, and enable Hermes. Provider setup is not available in the
mobile app.

Two things go beyond installing the CLI.

**The ACP adapter is an optional extra.** Hermes ships it as a Python extra, so a
stock install answers `hermes --version` and then cannot speak the protocol T3 Code
uses. Install it with `pip install -e '.[acp]'` in the Hermes checkout; the official
installer already does. T3 Code runs `hermes acp --check` when it probes the
provider and tells you specifically when the adapter is the missing piece, rather
than reporting Hermes as not installed.

**Hermes brings no models.** It federates OpenRouter, Nous Portal, OpenAI,
Anthropic, local endpoints, and anything you declare under `providers:` in
`~/.hermes/config.yaml`. Run `hermes model` once to pick a provider and sign in.
The model picker then fills itself from whatever you configured; an empty picker
after a successful connection means no provider credentials, not a broken install.
Model ids carry their provider as a prefix — `openrouter:z-ai/glm-5.2`, for
example — and a custom model entry has to include it.

Set **HERMES_HOME path** in provider settings to point at a Hermes home other than
`~/.hermes`. It holds `config.yaml`, `auth.json`, `state.db`, and your skills.

If sessions are slow to start, **Skip config.yaml MCP servers** in the provider's
settings starts them without the MCP servers Hermes' own `config.yaml` lists.

## Permission modes

Hermes is worth calling out because its own modes cover **file edits only**. See
[permission modes](./permission-modes.md) for what the four T3 Code modes mean in
general; against Hermes they land like this:

| T3 Code mode      | Hermes edit policy                                          |
| ----------------- | ----------------------------------------------------------- |
| Supervised        | Asks before every edit.                                     |
| Auto-accept edits | Auto-allows edits in the workspace and the temp directory.  |
| Auto              | Same as Auto-accept edits — Hermes has no automatic review. |
| Full access       | Auto-allows edits anywhere.                                 |

Shell commands are not covered by any of that. Hermes always asks T3 Code before
running one, and **Full access** is the only mode that answers for you.

Under Supervised, Auto, and Auto-accept edits, Hermes additionally refuses to touch
sensitive paths unasked — anything under `.git` or `.ssh`, and `.env*`, `id_rsa`,
or `id_ed25519` files. **Full access** does not carve out that exception: it
auto-answers every prompt T3 Code receives, sensitive-path edits included.

### Limiting Hermes to specific commands

Hermes' modes have no notion of "auto-approve this command but not that one" — it is edits-vs-not,
full stop. Hermes does have finer-grained command control, but it lives entirely on Hermes' side of
the connection, in its own `config.yaml`: a `command_allowlist` of glob patterns that run without
ever generating a prompt, and an `approvals.deny` list of patterns that are refused no matter what
T3 Code's permission mode is set to — including **Full access**.

The Hermes provider's settings expose both lists as **Command rules** on the provider instance's
configuration tab: **Always allow** patterns and **Always block** patterns, each written into
Hermes' `config.yaml` the next time a session starts. This is the practical middle ground for
running Hermes against a smaller local model — one you trust less to make its own judgment calls
but don't want interrupting you for every routine command. Allowlist what you already trust
(`git status*`, `cargo test*`, a build script) so it runs without a prompt in any mode, denylist
what should never run (`sudo *`, `rm -rf *`), and leave everything else asking as normal.

Two things are worth knowing about how the lists behave. First, T3 Code manages only the entries it
wrote. Adding a pattern in Settings writes it into `config.yaml` at the next session start, and
removing it there takes it back out again at the next session start — a revocation in Settings is a
real revocation. But T3 Code is not the only writer of these lists: Hermes appends to
`command_allowlist` whenever you answer "Allow always" to a live prompt, and you can hand-edit
either list directly. Entries from either of those sources do not appear in Settings and a sync
never removes them, so clearing one of those means editing `config.yaml` yourself. (T3 Code keeps
its record of what it wrote in a `.t3code-command-rules.json` file beside `config.yaml`; delete that
and it falls back to only ever adding.) Second, an allowlist match only ever applies to a plain
command — one with no `&&`, `;`, pipes, or `$(...)` — so a compound command cannot sneak an
unapproved step in behind an allowlisted prefix.

## Skills

Hermes reads skills from `<HERMES_HOME>/skills`, and from `.agents/skills` or
`.hermes/skills` in the project. Each skill is a directory with a `SKILL.md`
carrying [agentskills.io](https://agentskills.io) frontmatter. See
[commands and skills](./composer.md#commands-and-skills) for invoking them.

The picker lists what Hermes will actually load. Skills Hermes has disabled,
skills gated to another platform or environment, and project skills in a
repository you have not trusted with `hermes skills trust` do not appear.

## Delegated subtasks

Hermes can split work across subagents with its `delegate_task` tool. Each
fan-out appears in [agent work](./thread-sidebar.md#inspect-agent-work) as a
batch plus one row per subtask, named after the task Hermes wrote for it.

**A delegated subtask does not report back into the thread.** Hermes runs
top-level delegations in a background queue and delivers their results through
a channel its ACP adapter does not read, so the children finish, their results
are written to Hermes' own storage, and nothing returns to this session. Hermes
often says it will summarise the results when they arrive; on this connection
they never do. The batch is marked **Idle** when the turn ends, rather than
completed, because T3 Code cannot confirm what became of the children.

If you need the results in-thread, keep the work in one turn instead of
delegating it, or ask Hermes for a final answer rather than a fan-out.

## Context and compaction

Hermes compresses context automatically as a thread approaches the model's
limit, so a Hermes thread needs no manual compacting: `/compact` and the
context meter's compact action are not offered against it. To compress the
conversation on demand, send Hermes' own `/compress` command.

## Limits

Hermes stores its sessions in a SQLite `state.db` rather than a readable
transcript, so it contributes nothing to the [Usage](./usage.md) page.
Context-window telemetry still arrives live during a thread.

Individual subagents cannot be opened, steered, or stopped from T3 Code, and
neither their progress nor their token usage is reported: Hermes names them
when it dispatches them and says nothing further over this connection.
