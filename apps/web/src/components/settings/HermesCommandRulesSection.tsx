"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface CommandPatternListProps {
  readonly idPrefix: string;
  readonly label: string;
  readonly description: string;
  readonly placeholder: string;
  readonly patterns: ReadonlyArray<string>;
  readonly onChange: (next: ReadonlyArray<string>) => void;
}

/** One editable list of glob patterns: existing entries as removable chips, plus an add row. */
function CommandPatternList({
  idPrefix,
  label,
  description,
  placeholder,
  patterns,
  onChange,
}: CommandPatternListProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const trimmed = input.trim();
    if (!trimmed) {
      setError("Enter a command pattern.");
      return;
    }
    if (patterns.includes(trimmed)) {
      setError("That pattern is already in the list.");
      return;
    }
    onChange([...patterns, trimmed]);
    setInput("");
    setError(null);
  };

  const handleRemove = (pattern: string) => {
    onChange(patterns.filter((existing) => existing !== pattern));
  };

  return (
    <div>
      <div className="text-xs font-medium text-foreground">{label}</div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      {patterns.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {patterns.map((pattern) => (
            <span
              key={pattern}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground/90"
            >
              {pattern}
              <button
                type="button"
                className="text-muted-foreground/70 hover:text-foreground"
                aria-label={`Remove ${pattern}`}
                onClick={() => handleRemove(pattern)}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex gap-2">
        <Input
          id={`${idPrefix}-input`}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            handleAdd();
          }}
          placeholder={placeholder}
          spellCheck={false}
          className="font-mono text-xs"
        />
        <Button className="shrink-0" variant="outline" onClick={handleAdd}>
          <PlusIcon className="size-3.5" />
          Add
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export interface HermesCommandRulesSectionProps {
  readonly instanceId: string;
  readonly commandAllowlist: ReadonlyArray<string>;
  readonly commandDenylist: ReadonlyArray<string>;
  readonly onCommandAllowlistChange: (next: ReadonlyArray<string>) => void;
  readonly onCommandDenylistChange: (next: ReadonlyArray<string>) => void;
}

/**
 * Hermes-only "Command rules" section.
 *
 * These patterns are synced into Hermes' own `config.yaml`
 * (`command_allowlist` / `approvals.deny`) and enforced by Hermes itself,
 * inside its process, before a shell command ever reaches T3 Code as a
 * `session/request_permission` prompt — see `docs/user/permission-modes.md`
 * for the full semantics. The two lists behave differently on purpose: an
 * allow match skips the prompt entirely, in any permission mode; a deny
 * match blocks the command unconditionally, even in Full access. T3 only
 * ever adds patterns here — removing one from this list does not delete a
 * pattern Hermes or an administrator added on their own, on the Hermes side.
 */
export function HermesCommandRulesSection({
  instanceId,
  commandAllowlist,
  commandDenylist,
  onCommandAllowlistChange,
  onCommandDenylistChange,
}: HermesCommandRulesSectionProps) {
  return (
    <div className="space-y-5">
      <div>
        <div className="text-sm font-medium text-foreground">Command rules</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Glob patterns Hermes checks itself, before a shell command ever reaches T3 Code for
          approval. Useful when running smaller local models: let routine commands through without a
          prompt, and hard-block the ones that should never run.
        </p>
      </div>
      <CommandPatternList
        idPrefix={`provider-instance-${instanceId}-command-allowlist`}
        label="Always allow"
        description="Matching commands run without asking, in any permission mode. Skipped for commands containing shell operators like && or ; — Hermes treats those as unsafe to shortcut."
        placeholder="git status*"
        patterns={commandAllowlist}
        onChange={onCommandAllowlistChange}
      />
      <CommandPatternList
        idPrefix={`provider-instance-${instanceId}-command-denylist`}
        label="Always block"
        description="Matching commands are refused unconditionally, even in Full access mode."
        placeholder="sudo *"
        patterns={commandDenylist}
        onChange={onCommandDenylistChange}
      />
    </div>
  );
}
