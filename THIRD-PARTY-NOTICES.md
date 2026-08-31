# Third-party notices

## PineTS (`pinets`) — AGPL-3.0-only OR LuxAlgo Commercial License

- **Package:** `pinets` (npm), https://github.com/LuxAlgo/PineTS — © 2026 LuxAlgo.
- **License:** AGPL-3.0-only (SPDX: `AGPL-3.0-only`); the package ships its own
  `LICENSE` file in `frontend/node_modules/pinets/LICENSE`. Dual licensing with a
  paid commercial license is offered by LuxAlgo.
- **Used by:** `frontend/src/services/pineEngine.ts` +
  `frontend/src/services/pineIndicators.ts` (the AURA "PineTS indicator engine").
- **Purpose:** runs Pine Script® v6 indicator code client-side
  (`ta.ema()` in Phase 1) as AURA's indicator calculation engine.
- **Bundled:** yes — PineTS is compiled into the production frontend bundle
  (it is a runtime dependency of the chart, not a dev-only tool).

### What AGPL-3.0 means for AURA here (plain-language summary, not legal advice)

- **Private / personal / internal use, research, and self-hosting for yourself
  or inside your own organisation: fine.** AURA's current intended usage
  (personal trading dashboard, no distribution, no hosted service offered to
  third parties) satisfies the AGPL-3.0 terms with no further obligations
  beyond preserving copyright/license notices.
- **If AURA is ever DISTRIBUTED to others or offered as a network service
  (SaaS)** — the two classic copyleft triggers of the AGPL — then the whole
  combined work must be released under AGPL-3.0 (users of a network service
  must be offered the corresponding source), **or** a LuxAlgo commercial
  license must be purchased for that distribution model.
- This integration deliberately does **not** modify, patch, vendor-edit,
  bundle-copy, or otherwise obscure PineTS or its licensing. It consumes the
  package as published on npm, unmodified, as a normal dependency.

### If AURA's distribution model changes

Stop and re-evaluate BEFORE distributing: either open-source the full
derivative work under AGPL-3.0 (including the PineTS engine integration), or
obtain a commercial license from LuxAlgo covering the intended model.
Do not attempt to circumvent the copyleft in either case.
