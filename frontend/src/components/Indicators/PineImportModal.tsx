import { useEffect, useRef, useState } from "react";

import {
  MAX_PINE_SOURCE_LENGTH,
  type ImportedPineIndicator,
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
  /** Adds the reviewed indicator (App-owned state + persistence). */
  onImportConfirm: (indicator: ImportedPineIndicator) => void;
  onClose: () => void;
}

/** Human header per issue kind — never a raw stack trace. */
function issueHeader(kind: NonNullable<PineImportOutcome["issue"]>["kind"]): string {
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

/** Short human label per visual type for the diagnostics panel. */
const TYPE_LABEL: Record<string, string> = {
  line: "line",
  histogram: "histogram",
  area: "area",
  horizontal: "hline",
  marker: "markers",
};

/**
 * Import Pine Script modal — name + code editor + Compile/Clear/Cancel.
 *
 * The "editor" is deliberately a plain monospace <textarea>: no heavyweight
 * editor dependency for phase 1 (bundle impact). Compile runs the script
 * through PineTS via App's pipeline; errors render in a friendly box.
 */
export function PineImportModal({ onCompile, onImportConfirm, onClose }: Props) {
  const [name, setName] = useState("");
  const [source, setSource] = useState(EXAMPLE_SOURCE);
  const [issue, setIssue] = useState<PineImportOutcome["issue"] | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  /** Successful compile awaiting user confirmation (diagnostics review). */
  const [review, setReview] = useState<ImportedPineIndicator | null>(null);
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  /** Editing the source invalidates any previous compile result. */
  const invalidateReview = (): void => {
    if (review !== null) setReview(null);
    if (warning !== null) setWarning(null);
  };

  const compile = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setIssue(null);
    setWarning(null);
    setReview(null);
    try {
      const outcome = await onCompile(name, source);
      if (outcome.ok && outcome.indicator) {
        if (outcome.warning) setWarning(outcome.warning);
        const d = outcome.indicator.diagnostics;
        // Fast path: everything the script uses is renderable → import at
        // once. Otherwise show the review panel (Detected/Rendered/Not
        // rendered) and let the user decide.
        const needsReview = d !== undefined && (d.unsupported.length > 0 || d.hidden > 0 || d.rendered.length === 0);
        if (needsReview) {
          setReview(outcome.indicator);
        } else {
          onImportConfirm(outcome.indicator);
          onClose();
        }
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
            onChange={(e) => {
              invalidateReview();
              setName(e.target.value);
            }}
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
          onChange={(e) => {
            invalidateReview();
            const next = e.target.value.slice(0, MAX_PINE_SOURCE_LENGTH);
            setSource(next);
          }}
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

        {review && review.diagnostics && (
          <div className="pine-diag" role="status">
            <div className="pine-diag-title">✅ Compiled successfully</div>
            {Object.entries(review.diagnostics.staticCounts).length > 0 && (
              <div className="pine-diag-row">
                <span className="pine-diag-label">Detected:</span>
                {Object.entries(review.diagnostics.staticCounts).map(([label, n]) => (
                  <span key={label} className="pine-diag-item">
                    {label} × {n}
                  </span>
                ))}
              </div>
            )}
            {review.diagnostics.rendered.length > 0 && (
              <div className="pine-diag-row">
                <span className="pine-diag-label">Rendered:</span>
                {review.diagnostics.rendered.map((r) => (
                  <span key={`${r.type}:${r.key}`} className="pine-diag-item ok">
                    ✓ {r.title}
                    <em> ({TYPE_LABEL[r.type] ?? r.type})</em>
                  </span>
                ))}
              </div>
            )}
            {review.diagnostics.unsupported.length > 0 && (
              <div className="pine-diag-row">
                <span className="pine-diag-label">Not rendered:</span>
                {review.diagnostics.unsupported.map((u) => (
                  <span key={u.kind} className="pine-diag-item warn">
                    ⚠ {u.kind} × {u.count}
                  </span>
                ))}
              </div>
            )}
            {review.diagnostics.hidden > 0 && (
              <div className="pine-diag-row">
                <span className="pine-diag-label">Hidden:</span>
                <span className="pine-diag-item">
                  {review.diagnostics.hidden} plot{review.diagnostics.hidden === 1 ? "" : "s"} with display=display.none
                </span>
              </div>
            )}
            {review.diagnostics.rendered.length === 0 && (
              <div className="pine-diag-note">
                Nothing renderable was produced against the current candles. The script still imports — you can keep
                it and revisit once AURA supports more outputs.
              </div>
            )}
          </div>
        )}

        {issue && (
          <div className="pine-issue" role="alert">
            <div className="pine-issue-title">❌ {issueHeader(issue.kind)}</div>
            <pre className="pine-issue-msg">{issue.message}</pre>
          </div>
        )}
        {warning && !review && (
          <div className="pine-warning" role="status">
            ⚠ {warning}
          </div>
        )}

        <div className="pine-actions">
          {review ? (
            <>
              <button
                type="button"
                className="pine-btn primary"
                onClick={() => {
                  onImportConfirm(review);
                  onClose();
                }}
                disabled={busy}
              >
                Import
              </button>
              <button type="button" className="pine-btn" onClick={() => void compile()} disabled={busy}>
                Recompile
              </button>
            </>
          ) : (
            <button type="button" className="pine-btn primary" onClick={() => void compile()} disabled={busy}>
              {busy ? "Compiling…" : "Compile"}
            </button>
          )}
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
