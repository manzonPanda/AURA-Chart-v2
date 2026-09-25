import type { LiveTradeOverlay } from "./tradeOverlay.ts";

/** Ephemeral, non-authoritative P&L/R hint relayed over the existing authenticated stream. */
export interface LivePositionVisualFrame {
  readonly type: "tradeVisual";
  readonly accountId: string;
  readonly ticket: string;
  readonly profit: number;
  readonly swap: number;
  readonly slValue: number | null;
  readonly sourceId: string;
  readonly sourceSequence: number;
  /** Server-assigned monotonic ordering token; never interpreted as MT5 time. */
  readonly sequence: number;
  readonly at: string | null;
}

export interface LivePositionVisualEntry {
  readonly accountId: string;
  readonly ticket: string;
  readonly netPnl: number;
  readonly liveR: number | null;
  readonly sourceId: string;
  readonly sourceSequence: number;
  readonly sequence: number;
}

export type LivePositionVisualMap = ReadonlyMap<string, LivePositionVisualEntry>;
export type LivePositionVisualOrder = Pick<
  LivePositionVisualEntry,
  "sourceId" | "sourceSequence" | "sequence"
>;
export type LivePositionVisualOrderMap = ReadonlyMap<string, LivePositionVisualOrder>;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Stable account + ticket key; a ticket alone is never an identity boundary. */
export function livePositionVisualKey(accountId: string, ticket: string | null | undefined): string | null {
  const normalizedAccount = String(accountId ?? "").trim();
  const normalizedTicket = String(ticket ?? "").trim();
  return normalizedAccount && normalizedTicket ? `${normalizedAccount}:${normalizedTicket}` : null;
}

/** True when a frame is newer than the last accepted ordering token for its key. */
export function isNewerLivePositionVisual(
  previous: LivePositionVisualOrderMap,
  frame: Pick<LivePositionVisualFrame, "accountId" | "ticket" | "sourceId" | "sourceSequence" | "sequence">,
): boolean {
  const key = livePositionVisualKey(frame.accountId, frame.ticket);
  if (!key) return false;
  const prior = previous.get(key);
  if (!prior) return true;
  if (frame.sourceId === prior.sourceId) return frame.sourceSequence > prior.sourceSequence;
  return frame.sequence > prior.sequence;
}

/** Validate an untrusted relay frame before it can enter React state. */
export function parseLivePositionVisualFrame(raw: unknown): LivePositionVisualFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.type !== "tradeVisual") return null;
  const accountId = typeof value.accountId === "string" ? value.accountId.trim() : "";
  const ticket = typeof value.ticket === "string" || typeof value.ticket === "number"
    ? String(value.ticket).trim()
    : "";
  const sourceId = typeof value.sourceId === "string" ? value.sourceId.trim() : "";
  if (!accountId || !ticket || !sourceId) return null;
  if (!finite(value.profit) || !finite(value.swap)) return null;
  if (value.slValue !== null && !finite(value.slValue)) return null;
  if (!finite(value.sourceSequence) || value.sourceSequence < 0) return null;
  if (!finite(value.sequence) || value.sequence < 0) return null;
  return {
    type: "tradeVisual",
    accountId,
    ticket,
    profit: value.profit,
    swap: value.swap,
    slValue: value.slValue as number | null,
    sourceId,
    sourceSequence: value.sourceSequence,
    sequence: value.sequence,
    at: typeof value.at === "string" ? value.at : null,
  };
}

/**
 * Apply one frame only to an already-authoritative selected-account position.
 * Same-source ordering is checked first; cross-source ordering uses the server
 * sequence. A missing/zero native SL risk retains the last valid visual R.
 */
export function applyLivePositionVisual(
  previous: LivePositionVisualMap,
  frame: LivePositionVisualFrame,
  authoritativeKeys: ReadonlySet<string>,
  selectedAccountId: string | null | undefined,
): LivePositionVisualMap {
  const selected = String(selectedAccountId ?? "").trim();
  if (!selected || frame.accountId !== selected) return previous;
  const key = livePositionVisualKey(frame.accountId, frame.ticket);
  if (!key || !authoritativeKeys.has(key)) return previous;

  const prior = previous.get(key);
  if (prior) {
    if (frame.sourceId === prior.sourceId && frame.sourceSequence <= prior.sourceSequence) {
      return previous;
    }
    if (frame.sourceId !== prior.sourceId && frame.sequence <= prior.sequence) {
      return previous;
    }
  }

  const netPnl = round2(frame.profit + frame.swap);
  const liveR = frame.slValue !== null && Math.abs(frame.slValue) > 0
    ? round2(netPnl / Math.abs(frame.slValue))
    : prior?.liveR ?? null;
  const next = new Map(previous);
  next.set(key, {
    accountId: frame.accountId,
    ticket: frame.ticket,
    netPnl,
    liveR,
    sourceId: frame.sourceId,
    sourceSequence: frame.sourceSequence,
    sequence: frame.sequence,
  });
  return next;
}

/** Drop transient values for a closed/unknown position or an account switch. */
export function reconcileLivePositionVisuals(
  previous: LivePositionVisualMap,
  authoritativeKeys: ReadonlySet<string>,
  selectedAccountId: string | null | undefined,
): LivePositionVisualMap {
  const selected = String(selectedAccountId ?? "").trim();
  let changed = false;
  const next = new Map(previous);
  for (const [key, entry] of next) {
    if (entry.accountId !== selected || !authoritativeKeys.has(key)) {
      next.delete(key);
      changed = true;
    }
  }
  return changed ? next : previous;
}

/** Replace transient hints after a successful authoritative state response. */
export function clearLivePositionVisuals(): LivePositionVisualMap {
  return new Map();
}

/**
 * Merge only P&L/R onto a copy of the authoritative display overlays. SL/TP,
 * sensitivity, and every account-risk input remain untouched.
 */
export function applyLivePositionVisualsToOverlays(
  authoritative: readonly LiveTradeOverlay[],
  visuals: LivePositionVisualMap,
  selectedAccountId: string | null | undefined,
): LiveTradeOverlay[] {
  const selected = String(selectedAccountId ?? "").trim();
  return authoritative.map((overlay) => {
    const key = livePositionVisualKey(selected, overlay.ticket);
    const visual = key ? visuals.get(key) : undefined;
    if (!visual) return overlay;
    return {
      ...overlay,
      netPnl: visual.netPnl,
      liveR: visual.liveR,
    };
  });
}
