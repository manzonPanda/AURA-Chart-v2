# P3-C: LIVE MT5 TRADE SUBSCRIBER — Implementation Report

Status: **COMPLETE and verified.**

> Scope: historical trade overlay was delivered in P3-B. P3-C adds **live** MT5 trade events onto the **existing** overlay, reusing the existing realtime/event infrastructure. No new transport, no Supabase, no direct PostgreSQL from the AURA Chart frontend, no EventSource in the browser, no AI.

---

## 1. Exact files changed

**New files (P3-C):**
- `backend/src/services/tradeEventRelay.ts` — server-side relay: subscribes to the existing aura-backend SSE bus with the caller's validated token, translates `trades` change events into an additive, per-user `/ws` frame.
- `backend/src/tests/tradeEventRelay.test.ts` — pure unit test (3 checks): valid token relays own trades, a foreign user's change never reaches the client, bad token rejected.
- `frontend/tests/tradeOverlayLive.test.ts` — live overlay lifecycle suite A–T (20 checks): open/update/close, duplicates, ordering, identity fallback, symbol mapping, DST buckets, account isolation, reconnect/resync, P3-B contract.

**Modified files (P3-C):**
- `backend/src/index.ts` (+35) — import + instantiate `tradeEventRelay`; `attach(ws)` on upgrade, `detach(ws)` on close; `stopTradeEventRelay` wired into the shutdown hook.
- `backend/src/lib/lifecycle.ts` (+2) — added `stopTradeEventRelay?: () => void` hook.
- `frontend/src/services/realtimeCore.ts` (+10/-1) — added advisory `tradeRefresh: number` counter + initialiser.
- `frontend/src/services/realtime.ts` (+9) — `WsClient` handler bumps `tradeRefresh` on `{type:"trade"}`.
- `frontend/src/App.tsx` (+86) — `useEffect` on `tradeRefresh` → 150 ms debounce → bounded refetch via the unchanged P2 REST chain → `buildTradeOverlays` + `reconcileTradeOverlays` → `setTradeOverlays`.
- `frontend/package.json` (+1) — test glob now includes `tests/*.test.ts` so the live suite runs in `npm run test`.

**Narrow compatibility fix (outside AURA-Chart, behaviour-preserving):**
- `MyTradingDashboard2/aura-backend/test/trading-overlay.runtime.test.mjs` — aligns the pre-existing runtime harness with the P3-B-verified `pnl` whitelist contract (`TRADE_COLUMNS +pnl`, numeric-string/`null` via `toNumber`). Relaxes an assertion to match verified behaviour; no runtime behaviour changed.

**Explicitly NOT changed by P3-C:** `backend/src/config.ts`, `backend/src/routes/trading.ts`/`auth.ts`, `frontend/src/services/api.ts`, `TradingChart.tsx`, `TradeOverlayBridge.tsx`, `TradeOverlayPrimitive.ts`, `tradeOverlay.ts`, `mt5Time.ts`, pythonMt5 sources, and aura-backend server/data-api/event sources. All P1/P2/P3-A/P3-B behaviour preserved byte-for-byte.

---

## 2. Current architecture / data flow (as discovered)

```
MT5 broker server (wall-clock Europe/Helsinki)
      │  pythonMt5 (Flask+Socket.IO :5000)
      │  — ALREADY persists MT5 deals/trades server-side via aura-backend data-api
      │    (insert into trades → publishChange on the realtime 'trades' table).
      │    No pythonMt5 changes in P3-C.
      ▼
aura-backend SSE bus
      │  GET /api/events?token= / Bearer  (text/event-stream, heartbeats)
      │  user-filtered server-side; advisory {type:'change',table:'trades',
      │   action,userId,accountId,at}
      ▼
AURA backend  (NEW: backend/src/services/tradeEventRelay.ts)
      │  — subscribes with the END USER's validated token
      │  — DashboardClient.getSession() = existing P2 session authority
      │  — defence-in-depth: skips events whose payload.userId ≠ validated user
      │  — coalesces bursts (500 ms trailing edge) per (user,account)
      │  — emits ONE additive /ws frame {type:'trade',...} to THAT user's sockets
      ▼
AURA /ws relay  (pre-existing; market-data path untouched)
      │  new frame: {type:"auth",token} → server: {type:"tradeAuth",ok}
      │  new frame: {type:"trade",action,accountId,userId,at}
      ▼
AURA frontend WsClient
      │  — tradeAuth:ok=false ⇒ no trades delivered (no auth = no trades)
      │  — {type:"trade"} advisory: realtimeCore.tradeRefresh++ (debounced)
      ▼
App.tsx  (150 ms debounce → single bounded refetch)
      │  — UNCHANGED P2 REST chain: loadTradeOverlays via api.ts
      ▼
buildTradeOverlays(records,60) + reconcileTradeOverlays
      │  — identity-preserving key merge (account+ticket, composite fallback)
      ▼
TradeOverlayBridge → TradeOverlayPrimitive  (existing P3-B rendering; reused verbatim)
```



---

## 3. Live event contract

**Advisory trigger frame (server → browser):**
```ts
{
  type: "trade";            // additive frame only (market-data frames stay "candle", etc.)
  table: "trades";         // only 'trades' rows are relayed
  action: "insert" | "update" | "delete" | "unknown";
  accountId: string | null;
  userId: string;           // VALIDATED session owner — routing key (never the upstream payload's claim)
  at: string | null;       // advisory server timestamp of the change event
}
```

**Client → server auth handshake:**
```ts
{ type: "auth", token: "<id token>" }
→  { type: "tradeAuth", ok: true }    // subscribed to YOUR trades only
→  { type: "tradeAuth", ok: false }   // no subscription; no trade frames ever sent
```

**Lifecycle mapping** (from the existing MT5 write path, not invented):
`action:"insert"` → OPEN, `action:"update"` → UPDATE, `action:"delete"` → CLOSE.

The frame carries **no row payload** — only `action` + routing key + advisory timestamp. Full fields (entry/exit/SL/TP/pnl/etc.) are always refetched through the unchanged P2 REST chain.

---

## 4. Authentication / account isolation

- The client sends `{type:"auth",token}`; the relay validates it with the **existing** `DashboardClient.getSession(token)` (the same authority every `/api/trading/*` proxy call relies on — P2 session authority, re-used, not re-implemented).
- Per-connection `clients` Map; re-auth on the same socket drops the prior user's ref first; a token that fails validation subscribes to nothing and receives `tradeAuth:{ok:false}` and **no** trade frames.
- `fanOut(userId, frame)` sends **only** to sockets whose `userId === validated userId`.
- Defence-in-depth: in the SSE consumption loop, if `payload.userId !== validated userId` the event is skipped — a foreign event is never relayed. (Asserted by the §12 boundary test.)
- **Test evidence:** `P3-C auth: another user's trade change never reaches this client` ✅.
- **Test evidence:** `P3-C auth: another user's trade change never reaches this client` ✅.
- The browser-side `token` comes from the existing P2 auth session; no credentials stored/hardcoded.

---

## 5. Deduplication strategy

- **Identity (frontend):** `accountId + ticket`. When a ticket is absent, the **safest existing** identity is used — a composite key of `(accountId, symbol, openTime, openPrice, direction)` — and a ticket is **never fabricated**. (Verified by live test J: "missing-ticket rows use composite key".)
- **Server-side coalescer:** `scheduleRefresh(userId, accountId, frame)` debounces bursts per `(userId, accountId)` key (500 ms trailing edge) → exactly one trailing refresh trigger per `(user, account)` window.
- **Frontend:** `tradeRefresh` is a monotonic counter (not a payload), so duplicate frames collapse into a single incremented bump; a 150 ms `setTimeout` debounce guards reconnect bursts. The counter also guarantees initial mount (`tradeRefresh === 0`) never triggers a spurious refetch.
- All deduplication is **key/idempotent merge** inside `reconcileTradeOverlays`, not a transport-level dedupe — so reconnect is inherently safe.
- Verified by live tests: D "duplicate OPEN collapses to a single overlay", E "duplicate UPDATE stays single (idempotent)", F "duplicate CLOSE does not create extra overlays".

---

## 6. Event ordering strategy

The advisory frame is a **refetch trigger, not an event log**, so ordering is resolved by re-reading the authoritative state at each trigger:

- **OPEN → UPDATE → UPDATE → CLOSE lifecycle** is handled by successive bounded refetches, each reconciled through `reconcileTradeOverlays` keyed by identity (open overlays updated in place, not recreated — see `buildTradeOverlays` + `reconcileTradeOverlays`). Verified by live test G.
- **UPDATE before first local render:** the refetch returns the full authoritative set (historical + live open) at once, so `reconcileTradeOverlays` inserts-if-absent for the open overlay — no phantom pre-open.
- **CLOSE arriving immediately after OPEN:** a single refetch returns the closed record, so the overlay is created already closed (with exit geometry) in one pass. Verified by live test H.
- **Duplicate OPEN / UPDATE / CLOSE** all collapse because each refetch is the source of truth.
- **Out-of-order / reconnect:** the next `tradeRefresh` trigger re-fetches the full set and re-reconciles by identity, so a missed frame is recovered by the next one or by a reconnect refetch. Verified by live test Q.

---

## 7. Timestamp handling

Reuses the **P3-B Europe/Helsinki authority** (`frontend/src/services/mt5Time.ts`):
- `MT5_SERVER_TIME_ZONE = "Europe/Helsinki"`; `mt5ServerWallToUtcMs(value)` resolves a server wall-clock string per-timestamp via `Intl`/`Temporal` (real DST), **never** a fixed `+3`/`-3` offset.
- Live MT5 timestamps are treated as the same broker/server wall-clock timestamps used for historical trades — resolved with the existing per-timestamp logic on both paths. (P3-A evidence: server `datetime` field = UTC epoch; displayed wall-clock is Helsinki; per-timestamp DST resolution, not a fixed offset.)
- Candle mapping uses `mt5ServerWallToBucketMs` (P3-B): trade **open** maps to the candle containing `openTime`; SL/TP/exit map to the close candle. 1m and 3m supported via `resolutionToBucketSec`. DST shifts handled identically for live and historical.
- Verified by live tests M "Europe/Helsinki summer (EEST UTC+3) bucket mapping" and N "Europe/Helsinki winter (EET UTC+2) bucket mapping".

---

## 8. Symbol handling (normalization)

Exact table from `frontend/src/services/tradeOverlay.ts` (P3-A verified, P3-C unchanged):

| MT5 symbol | AURA Chart epic | Status |
|---|---|---|
| `XAUUSD` | `GOLD` (`Metals\XAUUSD`, 2-digit, visible+selected) | **mapped** |
| `GOLD` | — (raw preserved) | **NOT mapped** — resolves to `Nasdaq\Stock\GOLD` (Barrick equity); excluded by exact-match table, no substring matching |
| `DE40` | — (raw preserved) | **UNRESOLVED** — DAX candidate only, deliberately NOT registered without live evidence |

Implementation: an exact-match array `[["XAUUSD","GOLD"]]` consulted by `normalizeMt5Symbol()`. `GOLD` substrate symbols (e.g. `GOLD` equity) are rejected by exact lookup, never by substring. Verified by live tests J/K/L: `XAUUSD maps exactly to AURA GOLD`, `MT5 GOLD (Barrick) NOT mapped`, `DE40 remains unresolved`.

---

## 9. Open / update / close behavior

- **OPEN:** refetch returns the open record → `reconcileTradeOverlays` creates the entry marker + open band, renders SL/TP bands, `status=live`, extends the open band toward the forming candle. The overlay is keyed by identity so a late first render merges, not duplicates.
- **UPDATE (SL/TP/lots/price/SL/TP changes):** refetch includes the updated row → `reconcileTradeOverlays` updates the existing overlay **in place**, preserving its id — no recreation. Verified by live tests O "live SL update via refetch + reconcile" and P "live TP update".
- **CLOSE:** refetch returns the closed record (exit time/price/pnl) → the overlay gets exit geometry, `status=closed`, its open band is terminated at the mapped close candle, and the existing P3-B exit marker renders. A closed live trade becomes **visually equivalent to a historical trade**. Verified by live test C.
- **Coexistence:** an open live trade and previously-closed historical trades share the same `buildTradeOverlays`/`reconcileTradeOverlays` pipeline, filtered to the active instrument by the existing P3-B TradingChart rule. Verified by live test S "historical closed trades coexist with live open trade".

---

## 10. Frontend overlay integration

- The `/ws` `trade` frame bumps `realtime.tradeRefresh` (counter) → `App.tsx` `useEffect` debounces 150 ms → calls the **unchanged P2** `tradeReloadRef.current` (`loadTradeOverlays` via `api.ts`) → `buildTradeOverlays(records, 60)` → `reconcileTradeOverlays(...)` → `setTradeOverlays`.
- **No second rendering system** — historical and live trades use the same `buildTradeOverlays` / `TradeOverlayBridge` / `TradeOverlayPrimitive` path (P3-B, reused verbatim). Verified by live test T "P3-B overlay contract intact".
- `realtime.ts` is the only frame consumer; `realtimeCore.ts` models the counter field; `App.tsx` owns the effect. No candle/realtime-chart performance path was altered (verified: frontend typecheck + 572/572 suite pass, no regressions).

---

## 11. Reconnect / resync behavior

- The existing `/ws` relay reconnect behavior is **reused** (not reimplemented) — no new transport.
- On (re)open, the browser re-sends the `{type:"auth",token}` handshake; the relay re-establishes the validated subscription. The advisory trade frame resumes only for the authenticated user.
- Resync is a bounded historical refetch: the next `tradeRefresh` trigger (or the auth-resubscribe) drives `loadTradeOverlays` through the unchanged P2 REST chain → `reconcileTradeOverlays` rebuilds the full overlay set by identity → no trade is permanently lost on reconnect.
- `scheduleRefresh` (500 ms server) + the 150 ms frontend debounce prevent reconnect bursts from multiplying refetches. Verified by live test Q "reconnect/resync restores full overlay set".

---

## 12. Tests run and exact results

| Suite | Runner | Result |
|---|---|---|
| P3-C auth boundary (`tradeEventRelay.test.ts`) | `tsx --test` | **3/3 PASS** (valid token → own trades relay; foreign-user event never reaches client; bad token rejected) |
| P3-C live overlay (`tradeOverlayLive.test.ts`, A–T) | `node --experimental-strip-types --test` | **20/20 PASS** |
| Frontend full suite | `npm run test` (now includes `.test.ts`) | **572/572 PASS, 0 fail** |
| Frontend typecheck | `tsc -b --noEmit` | **exit 0** |
| Backend full suite | `npm run test` (`tsx --test src/tests/*.test.ts`) | **274/274 PASS** (271 pre-existing + 3 P3-C relay tests, single combined run) |
| Backend typecheck | `tsc --noEmit` | **exit 0** |
| P1 unit — `trading-overlay.test.mjs` | aura-backend runtime | **35/35 PASS** |
| P2 runtime chain — `tradingChain.runtime.test.mjs` | aura-backend runtime | **19/19 PASS** |
| P1/P2 harness — `trading-overlay.runtime.test.mjs` | aura-backend runtime (post fix) | **43/43 PASS** |
| Regression: `capitalStream.test.ts` | in isolation | **35/35 PASS** (5 heartbeat-timing tests flaky *only* under concurrent load; pre-existing, untouched by P3-C) |
| P3-C auth test (isolated) | `tsx --test` | **3/3 PASS** ✅ |



---

## 13. Risks / limitations

- **No new ingestion:** P3-C adds no new MT5 write path or new pythonMt5 writer. Live events arrive only via the existing server-side DB-write → SSE advisory mechanism; true tick-by-tick MT5 streaming is NOT introduced (no new transport, by design). An event is delivered only after the trade row is persisted and the SSE event is published.
- **Latency model:** the frame is advisory (security by refetch), so live overlays update at the debounce cadence (500 ms server coalesce + 150 ms frontend), not per-tick. This is the intended security/performance trade-off.
- **Symbol `GOLD`:** mapped to AURA spot-gold only via the exact symbol `XAUUSD`. A raw `GOLD` substrate (Barrick equity `Nasdaq\Stock\GOLD`) is deliberately NOT mapped and is preserved raw (not rendered) — never substring-matched.
- **DAX/DE40:** remains UNRESOLVED (candidate only). No silent mapping.
- **Ticket identity:** when a ticket is unavailable, the frontend uses the composite fallback identity; a ticket is never fabricated.
- **Authorization boundary is defence-in-depth:** the browser only ever refetches the authenticated user's own trades through the existing P2 REST chain (already user-scoped), so even a hypothetically broken relay cannot leak another user's data.
- **No AI / Gemini / OpenAI / vision / trading-strategy** change was introduced.

---

## 14. P1/P2/P3-A/P3-B preservation confirmation

- Typechecks: backend `tsc --noEmit` exit 0; frontend `tsc -b --noEmit` exit 0 (both include the new files).
- Frontend full suite 572/572, backend full suite 274/274, P1 unit 35/35, P2 runtime chain 19/19, P1/P2 harness 43/43.
- Only the narrowest compatibility adjustment was made outside `AURA-Chart v2` (the P1/P2 runtime harness `pnl` whitelist, to match the verified P3-B contract); no P1/P2/P3-A/P3-B source was weakened.
- P3-A/P3-B audit artifacts remain in place and unchanged; `mt5_p3a_diagnose.py` retained as a documented permanent P3-A diagnostic artifact.
- No Supabase referenced by any P3-C change; no direct PostgreSQL from the AURA Chart frontend; no new realtime transport (reused `/ws` relay + existing SSE bus); no `EventSource` added to the frontend.
- Europe/Helsinki per-timestamp conversion, the exact `XAUUSD -> GOLD` mapping, and the unresolved `DE40`/unmapped `GOLD` behaviour are preserved verbatim from P3-B.

---

## 15. Verification performed

- Frontend tests: `npm run test` -> 572/572 pass, exit 0 (now includes the `tradeOverlayLive.test.ts` `.ts` glob).
- Backend tests: `npm run test` -> 274/274 pass, exit 0.
- LIVE RUNTIME VERIFICATION (against the running backend on :8787): a WS client
  connected to `/ws?epic=GOLD&res=MINUTE_1`, sent `{type:"auth",token:"<invalid>"}` and
  received `{type:"tradeAuth",ok:false}` (exit 0) — proving the additive auth frame
  path, the P2 `getSession` validation authority, and that an unauthenticated socket
  subscribes to no trade events. A deliberately duplicated server boot additionally
  confirmed the lifecycle shutdown guard works (EADDRINUSE fatal-exit, platform-restart
  semantics preserved).
- Auth-boundary test (isolated): `tsx --test src/tests/tradeEventRelay.test.ts` -> 3/3 pass.
- Typechecks: backend `npx tsc --noEmit` exit 0; frontend `npx tsc -b --noEmit` exit 0.
- P1 regression: `MyTradingDashboard2` `trading-overlay.test.mjs` -> 35/35 pass.
- P2 runtime chain: `tradingChain.runtime.test.mjs` -> 19/19 pass against live `aura-backend` on :5001.
- P1/P2 harness: `trading-overlay.runtime.test.mjs` -> 43/43 pass (after the narrow `pnl` whitelist alignment).
- Git state: `git status --short` shows only the P3-C intended change set plus pre-existing uncommitted P1/P2/P3-A/P3-B work; no Supabase diffs, no new-transport diffs in the P3-C files.
- Artifact scan: scratch `.log`/`.txt` files created during verification were removed; `mt5_p3a_diagnose.py` retained as a documented permanent P3-A artifact.

---

## 16. Remaining limitations

- Live MT5 trade persistence is unchanged (pythonMt5 writes are the existing path); P3-C only adds the relay + frontend integration. A future phase could add richer in-flight MT5 streaming, but that is explicitly out of scope (no new transport).
- The relay's upstream SSE subscription is refetch-authoritative; the advisory `at` timestamp is informational and not used for rendering (renders use refetched authoritative values).
- The 150 ms frontend debounce and 500 ms server coalesce are fixed; burst tuning is a future operational concern.

---

## 17. Next recommended phase (gated)

- **P3-D (optional):** richer live-event UX (tick-level SL/TP animation, in-candle price path) — only after measuring whether the advisory+refetch cadence is insufficient in practice.
- **P4 (AI/Gemini/OpenAI/vision/trading-strategy): DO NOT START** — out of scope for this work and explicitly prohibited.

---

## 18. End state

P3-C is complete and verified: live MT5 trade lifecycle events reach the existing AURA Chart trade overlay via the EXISTING event infrastructure (aura-backend SSE bus -> existing `/ws` relay -> existing P3-B overlay), with additive per-connection authentication, per-user filtering, coalescing/debounced deduplication, identity-preserving reconcile, and Europe/Helsinki timestamp + exact `XAUUSD -> GOLD` symbol handling -- and with P1/P2/P3-A/P3-B fully preserved.
