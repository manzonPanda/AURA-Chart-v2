import { useEffect, useRef, useState } from "react";

import {
  MAX_PINE_SOURCE_LENGTH,
  type PineImportIssueKind,
  type PineImportOutcome,
} from "../../services/pineImport";

/** Starter script so first-run users see the expected shape immediately. */
const EXAMPLE_SOURCE = `//@version=6
indicator("My EMA", overlay=true)

emaFast = ta.ema(close, 9)
emaSlow = ta.ema(close, 20)

plot(emaFast, "EMA 9")
plot(emaSlow, "EMA 20")`;

interface Props {
  /** Runs the full compile pipeline against the current chart candles (App-owned). */
  onCompile: (name: string, source: string) => Promise<PineImportOutcome>;
  onClose: () => void;
}

/** Human header per issue kind — never a raw stack trace. */
function issueHeader(kind: PineImportIssueKind): string {
  switch (kind) {
    case "strategy":
    case "unsupported":
    case "version":
      return "Unsupported Pine feature";
    case "too-large":
      return "Script too large";
    case "limit":
      return "Import limit reached";
    case "plot":
      return "Nothing to render";
    default:
      return "Compilation failed";
  }
}

/**
 * Import Pine Script modal — name + code editor + Compile/Clear/Cancel.
 *
 * The "editor" is deliberately a plain monospace <textarea>: no heavyweight
 * editor dependency for phase 1 (bundle impact). Compile runs the script
 * through PineTS via App's pipeline; errors render in a friendly box.
 */
export function PineImportModal({ onCompile, onClose }: Props) {
  const [name, setName] = useState("");
  const [source, setSource] = useState(EXAMPLE_SOURCE);
  const [issue, setIssue] = useState<PineImportOutcome["issue"] | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const compile = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setIssue(null);
    setWarning(null);
    try {
      const outcome = await onCompile(name, source);
      if (outcome.ok) {
        // Parent adds the indicator and closes the modal; the warning (if any)
        // is surfaced on the indicator row by the menu.
        if (outcome.warning) console.info("[pineImport]", outcome.warning);
        onClose();
        return;
      }
      setIssue(outcome.issue ?? { kind: "run", message: "Compilation failed for an unknown reason." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="pine-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="pine-modal" role="dialog" aria-modal="true" aria-label="Import Pine Script">
        <div className="pine-modal-head">
          <h3>Import Pine Script</h3>
          <span className="pine-modal-sub">Pine Script powered by PineTS, with AURA-supported features.</span>
        </div>

        <label className="pine-name">
          <span>Name</span>
          <input
            type="text"
            placeholder="My indicator"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>

        <textarea
          ref={sourceRef}
          className="pine-editor"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          placeholder={EXAMPLE_SOURCE}
          value={source}
          onChange={(e) => setSource(e.target.value.slice(0, MAX_PINE_SOURCE_LENGTH))}
          onKeyDown={(e) => {
            // Two-space tab indent — the one editor nicety worth having.
            if (e.key === "Tab") {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: s, selectionEnd: t, value } = el;
              const next = `${value.slice(0, s)}  ${value.slice(t)}`;
              setSource(next.slice(0, MAX_PINE_SOURCE_LENGTH));
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = s + 2;
              });
            }
          }}
          disabled={busy}
        />
        <div className="pine-editor-meta">
          {source.length.toLocaleString()} / {MAX_PINE_SOURCE_LENGTH.toLocaleString()} chars · Pine v5/v6 · indicator() scripts only
        </div>

        {issue && (
          <div className="pine-issue" role="alert">
            <div className="pine-issue-title">❌ {issueHeader(issue.kind)}</div>
            <pre className="pine-issue-msg">{issue.message}</pre>
          </div>
        )}
        {warning && (
          <div className="pine-warning" role="status">
            ⚠ {warning}
          </div>
        )}

        <div className="pine-actions">
          <button type="button" className="pine-btn primary" onClick={() => void compile()} disabled={busy}>
            {busy ? "Compiling…" : "Compile"}
          </button>
          <span className="pine-actions-spacer" />
          <button
            type="button"
            className="pine-btn"
            onClick={() => {
              setSource("");
              setIssue(null);
              setWarning(null);
              sourceRef.current?.focus();
            }}
            disabled={busy}
          >
            Clear
          </button>
          <button type="button" className="pine-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
