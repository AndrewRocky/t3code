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

## Skills

Hermes reads skills from `<HERMES_HOME>/skills`, and from `.agents/skills` or
`.hermes/skills` in the project. Each skill is a directory with a `SKILL.md`
carrying [agentskills.io](https://agentskills.io) frontmatter. See
[commands and skills](./composer.md#commands-and-skills) for invoking them.

## Limits

Hermes stores its sessions in a SQLite `state.db` rather than a readable
transcript, so it contributes nothing to the [Usage](./usage.md) page.
Context-window telemetry still arrives live during a thread.
