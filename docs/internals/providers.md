# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Process and account isolation

T3-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
T3's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Reasoning has its own ACP channel: `agent_thought_chunk`, separate from the `agent_message_chunk`
that carries the answer. The shared model parses it as a distinct `ThoughtDelta`, and each adapter
decides whether its agent's thought channel is model reasoning worth showing. Antigravity and Hermes
re-emit it as a `reasoning_text` content delta; Cursor and Grok drop it, because their thought
channel also carries local status chatter. Do not resolve this in the shared parser — the same
notification means different things per agent.

ACP exposes permission modes two ways and an agent picks exactly one: a negotiated `mode`
_configuration option_, or a `SessionModeState` driven by `session/set_mode`. Cursor and Grok use
the config option; Hermes returns `configOptions: null` and advertises `modes`. Writing the config
option to an agent that does not negotiate one validates against an option that does not exist.
Grok also encodes the runtime mode as a spawn flag, while Hermes can only be told after the session
exists and never echoes the result back, so that mode is recorded optimistically and re-applied on
every session start. See [`AcpSessionRuntime.ts`](../../apps/server/src/provider/acp/AcpSessionRuntime.ts).

The shared runtime model parses only the turn-content notifications. An agent that sends more —
Hermes emits `usage_update`, `session_info_update`, and `available_commands_update` — needs a second
raw `session/update` handler in its adapter, because handlers append rather than replace. Hermes'
adapter re-emits the first two as `thread.token-usage.updated` and `thread.metadata.updated` and
ignores the third: its command list is a module constant on the Hermes side, so the provider
snapshot advertises it statically instead.

Skills and slash commands have no ACP surface at all in Hermes — `initialize` and `session/new`
mention no skill capability, and the only skill traffic a client sees is ordinary `tool_call`
notifications for Hermes' own `skills_list` / `skill_view` / `skill_manage` tools. Both are
therefore assembled provider-side, and each choice there is a constraint worth keeping:

- Slash commands are a constant in
  [`HermesProvider.ts`](../../apps/server/src/provider/Layers/HermesProvider.ts) attached to every
  snapshot an installed Hermes produces, degraded ones included, because Hermes intercepts them
  itself with no model call. Three of the nine are withheld: `model` collides with T3 Code's
  built-in `/model` (provider commands are deduplicated against skills, never against built-ins),
  and `steer` / `queue` duplicate native steering.
- Skills come from a recursive filesystem scan in
  [`HermesSkills.ts`](../../apps/server/src/provider/Drivers/HermesSkills.ts), because
  `hermes skills list` has no `--json` and the on-disk layout is the stable contract. Recursive is
  load-bearing: Hermes installs every skill under a category
  (`skills/<category>/<skill>/SKILL.md`), so a single-level scan finds none of the bundled ones.
  [`HermesSkillState.ts`](../../apps/server/src/provider/Drivers/HermesSkillState.ts) then
  annotates `enabled` from `hermes skills list --enabled-only`, the only route to Hermes' config
  denylists, its `platforms:` / `environments:` gates, and its trusted-project quarantine. That
  pass fails open in every failure mode, so it can never be the reason the picker is empty.
- Invoking a skill needs a bridge, because Hermes has no `$name` token syntax and the composer's
  `$skill` would otherwise arrive as prose.
  [`HermesSkillDirective.ts`](../../apps/server/src/provider/Drivers/HermesSkillDirective.ts)
  appends a directive naming the choice and asking Hermes to load it with `skill_view(name)`,
  leaving the user's own text intact. Inlining the `SKILL.md` was rejected: it spends the context
  Hermes is designed not to spend, and `skill_view(preprocess=True)` already runs Hermes' own
  preprocessing.

Subagents have no ACP surface either, and the shape of the workaround matters. Hermes generates a
full `subagent.*` stream — child id, parent id, depth, model, per-child tokens and summaries, which
its own gateway and TUI both consume — and then drops all of it at the ACP boundary, where
`acp_adapter/events.py` returns early on every event that is not `tool.started`. A fan-out is
therefore one ordinary `tool_call` of kind `execute`, which the generic path renders as
"Ran command". [`HermesSubagentProtocol.ts`](../../apps/server/src/provider/acp/HermesSubagentProtocol.ts)
recognises it instead, from a marker
[`HermesToolCallAugment.ts`](../../apps/server/src/provider/acp/HermesToolCallAugment.ts) stamps —
the augmenter is the last point at which the agent's own title is observable — and the adapter
raises it to `task.*` rather than emitting the work-log row.

Two properties of that tool call drive the rest of the design. Its ACP status reaches `completed`
within milliseconds, because a top-level delegation returns a dispatch handle rather than child
results, so a terminal status must **not** settle the row — only `failed` is a real terminal
signal, and everything else is held open until the turn ends. And the shared runtime forgets a tool
call the moment it completes, so identity has to be kept in the adapter's own sticky map or a later
frame arrives unmerged, with neither title nor marker. Both conclusions match the Antigravity
driver's, which solves the same problem for `start_subagent`.

The delegation path is also the one exception to "a notification with no active turn is dropped".
A delegation outlives its parent turn by construction, so its frames settle against
`lastSettledTurnId`; every other event keeps the original gate. What T3 Code cannot do is deliver
the children's results: Hermes pushes them onto an in-process completion queue that nothing in
`acp_adapter/` drains, so the batch settles to `idle` — never `completed` — with a description
saying so.

`HERMES_PLATFORM` is left unset on every Hermes spawn. It names a gateway channel (`cli`,
`discord`, …), not the host OS, and Hermes' own ACP adapter never sets it. An unrecognised value
would classify the session as a human messaging surface — `NON_MESSAGING_SESSION_SURFACES` is
default-deny — which silently turns `agent.verify_on_stop: auto` off. A user who wants that key to
apply can set the variable under the instance's environment variables, which are merged into the
spawn environment already.

Command-level approval granularity has no ACP surface at all. Hermes' own
`command_allowlist` and `approvals.deny` are checked before it ever sends
`session/request_permission`, and nothing in `initialize` exposes them, so the only integration
point is the `config.yaml` it reads (mtime-cached, so an edit mid-session applies without a
restart). [`HermesCommandRules.ts`](../../apps/server/src/provider/Drivers/HermesCommandRules.ts)
therefore scopes its merge by provenance rather than replacing either key. T3 Code is not the only
writer — Hermes appends to `command_allowlist` when a user answers "Allow always", and an
administrator may hand-edit either list — so the sync records the exact patterns it last wrote in
`<HERMES_HOME>/.t3code-command-rules.json`, then adds what settings list, removes what that record
claims and settings no longer list, and leaves every other entry alone. A missing or unreadable
record degrades to additive-only, so an entry of unknown authorship is never removed on a guess.
Treat any provider config file T3 Code shares with its agent this way.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).
