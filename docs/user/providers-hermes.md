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

## Permission modes

Hermes is worth calling out because its own modes cover **file edits only**. See
[permission modes](./permission-modes.md) for what the four T3 Code modes mean in
general; against Hermes they land like this:

| T3 Code mode          | Hermes edit policy                                        |
| --------------------- | --------------------------------------------------------- |
| Supervised            | Asks before every edit.                                   |
| Auto-accept edits     | Auto-allows edits in the workspace and the temp directory. |
| Full access           | Auto-allows edits anywhere.                               |

Shell commands are not covered by any of that. Hermes always asks T3 Code before
running one, and **Full access** is the only mode that answers for you.

Under Supervised and Auto-accept edits, Hermes additionally refuses to touch
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

Two things are worth knowing about how the lists behave. T3 Code only ever adds patterns, never
removes one: Hermes itself appends to `command_allowlist` whenever you answer "Allow always" to a
live prompt, and you can hand-edit either list directly, so a sync that deleted entries T3 Code did
not add could silently undo trust another actor granted. Removing a pattern for good means editing
`config.yaml`, not just clearing the field in Settings. And an allowlist match only ever applies to
a plain command — one with no `&&`, `;`, pipes, or `$(...)` — so a compound command cannot sneak an
unapproved step in behind an allowlisted prefix.

## Skills

Hermes reads skills from `<HERMES_HOME>/skills`, and from `.agents/skills` or
`.hermes/skills` in the project. Each skill is a directory with a `SKILL.md`
carrying [agentskills.io](https://agentskills.io) frontmatter. See
[commands and skills](./composer.md#commands-and-skills) for invoking them.

## Limits

Hermes stores its sessions in a SQLite `state.db` rather than a readable
transcript, so it contributes nothing to the [Usage](./usage.md) page.
Context-window telemetry still arrives live during a thread.
