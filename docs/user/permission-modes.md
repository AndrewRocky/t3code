# Permission Modes

A permission mode controls how much the agent does on its own and when it stops to ask you.

The mode is set per thread, from the mode control in the message composer. Changing it in one
thread does not change any other thread. A thread created from inside another thread keeps that
thread's mode; otherwise new threads start in **Full access** unless you pick something else
before sending.

## The Modes

**Supervised**: ask before commands and file changes. The agent pauses and shows you what it
wants to run or edit, and waits for approval. Work outside the workspace is restricted.

**Auto-accept edits**: auto-approve edits, ask before other actions. File changes go through
without prompting; commands and anything else still stop for approval.

**Auto**: routine actions proceed without you; risky ones still ask. How this is enforced depends
on the provider: Codex delegates routine approvals to an AI reviewer, Claude uses its own auto
permission mode, and providers without an equivalent (such as OpenCode) fall back to asking, like
Supervised.

**Full access**: allow commands and edits without prompts. The default. The agent runs
unattended until it finishes or asks a question of its own.

Approvals appear inline in the conversation. Approve or reject one and the agent continues from
there.

For Grok and Hermes, **Always allow this session** remembers the matching command or tool input.
Other actions still ask for approval. It does not change the thread to **Full access**.

## Choosing a Mode

Use **Full access** for work in a worktree or a sandbox you can throw away.

Use **Supervised** on a repository where an unwanted command is expensive, or the first time you
run an unfamiliar task.

**Auto-accept edits** suits refactors where the edits are the point and you only care about the
shell commands.

## Provider Behavior

Each provider maps these modes onto its own approval and sandbox settings. Codex, for example,
translates the mode into its approval policy and sandbox level, so **Supervised** runs the CLI
with prompting enabled and a restricted workspace while **Full access** disables both. Grok
threads do the same: **Supervised** starts Grok in ask mode even if your Grok CLI config is
set to always-approve, and **Full access** starts Grok with always-approve.

Hermes is worth calling out because its own modes cover file edits only. **Supervised** asks before
every edit, **Auto-accept edits** auto-allows edits inside the workspace and the temp directory, and
**Full access** auto-allows edits anywhere. Under **Supervised** and **Auto-accept edits**, Hermes
still asks before touching a sensitive path regardless of the edit otherwise being auto-allowed —
anything under `.git` or `.ssh`, and `.env*` / `id_rsa` / `id_ed25519` files. **Full access** does
not carve out an exception for this: it auto-answers every prompt T3 Code receives, sensitive-path
edits included. Shell commands always request approval from T3 Code regardless of mode, which is
why **Full access** is the only mode that answers them for you.

### Limiting Hermes to specific commands

Hermes' modes have no notion of "auto-approve this command but not that one" — it is edits-vs-not,
full stop. Hermes does have finer-grained command control, but it lives entirely on Hermes' side of
the connection, in its own `config.yaml`: a `command_allowlist` of glob patterns that run without
ever generating a prompt, and an `approvals.deny` list of patterns that are refused no matter what
T3 Code's permission mode is set to — including **Full access**.

The Hermes provider's settings expose both lists (**Command rules**, on the provider instance's
configuration tab): **Always allow** patterns and **Always block** patterns, each written into
Hermes' `config.yaml` the next time a session starts. This is the practical middle ground for
running Hermes against a smaller local model — one you trust less to make its own judgment calls
but don't want interrupting you for every routine command: allowlist the commands you already trust
(`git status*`, `cargo test*`, a build script) so they run without a prompt in any mode, denylist
the ones that should never run (`sudo *`, `rm -rf *`), and leave everything else asking as normal.

Two things worth knowing about how the lists behave. First, T3 Code manages only the entries it
wrote. Adding a pattern in Settings writes it into `config.yaml` at the next session start, and
removing it there takes it back out again at the next session start — a revocation in Settings is a
real revocation. But T3 Code is not the only writer of these lists: Hermes appends to
`command_allowlist` whenever you answer "Allow always" to a live prompt, and you can hand-edit
either list directly. Entries from either of those sources don't appear in Settings and a sync never
removes them, so clearing one of those means editing `config.yaml` yourself. (T3 Code keeps its
record of what it wrote in a `.t3code-command-rules.json` file beside `config.yaml`; delete that and
it falls back to only ever adding.) Second, an allowlist match only ever applies to a plain command —
one with no `&&`, `;`, pipes, or `$(...)` — so a compound command can't sneak an unapproved step in
behind an allowlisted prefix.

The labels above describe what you get; the exact per-provider translation is internal and may
change.

Mobile offers the same four modes with the same labels and descriptions.
