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

  return (
    <div>
      <label htmlFor={`${idPrefix}-input`} className="text-xs font-medium text-foreground">
        {label}
      </label>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      {patterns.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {patterns.map((pattern) => (
            <span
              key={pattern}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono text-2xs text-foreground/90"
            >
              {pattern}
              <button
                type="button"
                className="text-muted-foreground/70 hover:text-foreground"
                aria-label={`Remove ${pattern}`}
                onClick={() => onChange(patterns.filter((existing) => existing !== pattern))}
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
        />
        <div className="shrink-0">
          <Button variant="outline" onClick={handleAdd}>
            <PlusIcon className="size-3.5" />
            Add
          </Button>
        </div>
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
 * The settings form has no list control, so Hermes' two pattern lists get
 * their own section. The driver writes them into `command_allowlist` and
 * `approvals.deny` of Hermes' `config.yaml` before each session starts and
 * removes only the entries it wrote itself.
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
      <p className="text-xs text-muted-foreground">
        Glob patterns Hermes checks itself before a shell command reaches T3 Code for approval. Let
        routine commands through without a prompt, and block the ones that should never run. Changes
        reach Hermes&apos; own config the next time a session starts.
      </p>
      <CommandPatternList
        idPrefix={`provider-instance-${instanceId}-command-allowlist`}
        label="Always allow"
        description="Matching commands run without asking, in any permission mode. Commands with shell operators such as && or ; still ask."
        placeholder="git status*"
        patterns={commandAllowlist}
        onChange={onCommandAllowlistChange}
      />
      <CommandPatternList
        idPrefix={`provider-instance-${instanceId}-command-denylist`}
        label="Always block"
        description="Matching commands are refused, even in Full access."
        placeholder="sudo *"
        patterns={commandDenylist}
        onChange={onCommandDenylistChange}
      />
    </div>
  );
}
