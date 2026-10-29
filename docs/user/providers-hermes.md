# Hermes

T3 Code runs [Hermes Agent](https://hermes-agent.nousresearch.com) on your selected
environment through `hermes acp`. Hermes brings no models of its own: it uses the
providers you configure in Hermes.

## Set up Hermes

1. Install Hermes 0.22.3 or newer on the environment; 0.22.5 or newer is
   recommended. Older releases run a different ACP server that T3 Code does not
   support. Run `hermes --version` to check.
2. Run `hermes model` once to pick a provider and sign in.
3. On web or desktop, open **Settings → Providers**, choose the environment, and
   enable Hermes.

If T3 Code reports that the ACP adapter is missing, re-run the Hermes installer, or
install the `acp` extra in your Hermes checkout.

Set **HERMES_HOME path** to use a Hermes home other than `~/.hermes`. It holds
`config.yaml`, your credentials, skills and history.

### Hermes runs as a background service

`hermes acp` connects to Hermes' background service for that Hermes home, and
starts it if needed. The service is shared: the Hermes CLI, Hermes Desktop and
every T3 Code thread use the same one, and T3 Code threads appear in Hermes' own
session history.

Tools run in the service's environment, not T3 Code's. Environment variables you
set on the provider instance in T3 Code do not reach Hermes' commands, with the
exception of `HERMES_HOME`. Configure tools, `PATH` and API keys in Hermes itself.

## Models

The model picker shows the models Hermes offered the last time a Hermes session
started, and keeps them between restarts. To load them before your first thread,
refresh provider status in **Settings → Providers**; that opens one short session in
Hermes' history. **Default** keeps whatever model Hermes is configured to use. Model ids include their provider, such as
`openrouter:qwen/qwen3-coder`, and a custom model must include it too.

## Permission modes

Hermes asks before editing files according to the mode, and asks before running
commands it considers dangerous. See [permission modes](./permission-modes.md) for
the modes in general.

| T3 Code mode      | Hermes                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| Supervised        | Asks before every edit and every dangerous command.                        |
| Auto-accept edits | Edits in the workspace without asking; dangerous commands still ask.       |
| Full access       | Edits and runs commands without asking (Hermes' YOLO mode for the thread). |

Hermes offers no **Auto**. A Hermes thread already set to it runs in **Auto-accept
edits**. In **Full access**, Hermes still asks before touching sensitive paths such
as `.ssh` or `.env` files and for its own plugin approvals; those requests explain
why they appear.

A mode change applies at the start of the next turn. If Hermes is still busy with
earlier work, it applies at the following one.

### Command rules

**Command rules** in the provider settings hold two lists of glob patterns that
Hermes checks before it would ask you:

- **Always allow**: matching commands run without asking, in any mode. Commands
  with shell operators such as `&&`, `;`, pipes or `$(…)` still ask.
- **Always block**: matching commands are refused in every mode, including **Full
  access**.

T3 Code writes the lists into `command_allowlist` and `approvals.deny` in Hermes'
`config.yaml` when a session starts. It removes only the entries it added, and
records them in `.t3code-command-rules.json` beside `config.yaml`. Entries Hermes
added from an "Allow always" answer, or that you wrote by hand, are not shown and
stay in place.

## Skills

Hermes reads skills from `<HERMES_HOME>/skills` and from `.agents/skills` or
`.hermes/skills` in the project. Choosing one with `$` in the composer asks Hermes
to load it. See [commands and skills](./composer.md#commands-and-skills).

The picker lists only skills Hermes will load. Project skills need the repository to
be trusted with `hermes skills trust`. Hermes trusts a path, so a git worktree starts
untrusted even when its main checkout is trusted. Turn on **Trust worktrees of
trusted projects** to have T3 Code trust each worktree of a trusted project before
Hermes starts in it, and remove that trust once the worktree is gone. A worktree
can check out another branch, so its skills may differ from the ones you reviewed.

## Working with a running turn

A message you steer while Hermes works is delivered with Hermes' `/steer`, so Hermes
takes it into account without stopping. Hermes can steer only turns T3 Code started.
While it works on its own, for example reading a finished background job or
subagent, or a message from another Hermes app, a steered message waits and is
sent as the next turn once Hermes finishes. So is a steer with attachments.

Images and videos Hermes shares with `MEDIA:` appear in the conversation.

`/compact` asks Hermes to compress the conversation. If a turn is lost while Hermes
restarts, Hermes blocks the session until you discard it; send the `/discard`
command Hermes names in its message.

## Stopping Hermes

Closing a connection does not stop Hermes; its background service finishes the turn
regardless. So **Stop** keeps asking Hermes to stop until it confirms, and the turn
stays running until then. If Hermes still has not confirmed after about a minute of
retries, the turn stays running with the interrupt request shown; press **Stop**
again to retry. Archiving a thread or quitting T3 Code also tries to stop a turn T3
Code started.

While a thread is connected to Hermes, T3 Code shows Hermes working whenever it is,
including work T3 Code did not start, such as a message sent from another Hermes app
or the results of delegated subtasks. A message you send meanwhile waits for that
work to finish. T3 Code cannot stop such work on this Hermes version, and **Stop**
says so; it ends when Hermes finishes. Background terminal processes Hermes started
keep running after any Stop.

If T3 Code restarts while Hermes is working, Hermes keeps going. When T3 Code resumes
the thread, it shows that turn running and ends it when Hermes finishes, instead of
asking Hermes to continue. You can still answer Hermes' approvals and questions in
it, but not stop it, and a steered message waits until it ends. Until that turn
ends, Hermes cannot reach T3 Code's own tools, such as starting threads; its
terminal, file and web tools are unaffected.

## Delegated subtasks

Hermes runs subtasks from `delegate_task` in the background. Each one appears in
[agent work](./thread-sidebar.md#inspect-agent-work) and stays running until Hermes
records its result, even after the turn that started it ends. When they finish,
Hermes reads their results in a turn of its own, which appears in the thread. Their
progress is not reported until they finish.

## Limits

- **Edit from here** is not available: Hermes cannot rewind its own session to an
  earlier message from T3 Code yet. Forking a thread works and carries the
  conversation over.
- [Usage](./usage.md) counts a Hermes conversation on the day it was last active, since
  Hermes keeps one running total per session and model.
