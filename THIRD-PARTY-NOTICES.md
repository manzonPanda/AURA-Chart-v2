# Third-party notices

## Piner (`@heyphat/piner`) — AGPL-3.0-only

- **Package:** `@heyphat/piner` (npm) — Pine Script® v6 engine, v0.13.x.
- **License:** AGPL-3.0-only (SPDX: `AGPL-3.0-only`); the package ships its own
  `LICENSE` file in `node_modules/@heyphat/piner/LICENSE`.
- **Used by:** the frontend Pine engine (`frontend/src/services/pinePinerCore.ts`,
  `pinePinerEngine.ts`, `pineImport.ts`) and the backend EMA-alert adapter
  (`backend/src/emaAlert/pineEma.ts`).
- **Purpose:** compiles and executes Pine Script® v6 indicator code — the sole
  Pine engine for AURA's chart indicators, imports and server-side alerts.
- **Bundled:** yes — Piner is compiled into the production frontend bundle and
  installed as a backend runtime dependency.

### What AGPL-3.0 means for AURA here (plain-language summary, not legal advice)

- **Private / personal / internal use, research, and self-hosting for yourself
  or inside your own organisation: fine.** AURA's current intended usage
  (personal trading dashboard, no distribution, no hosted service offered to
  third parties) satisfies the AGPL-3.0 terms with no further obligations
  beyond preserving copyright/license notices.
- **If AURA is ever DISTRIBUTED to others or offered as a network service
  (SaaS)** — the two classic copyleft triggers of the AGPL — then the whole
  combined work must be released under AGPL-3.0 (users of a network service
  must be offered the corresponding source), **or** alternative licensing must
  be arranged with the engine's authors.
- AURA consumes the package as published on npm, unmodified, as a normal
  dependency — nothing modifies, patches, vendors or obscures the engine or
  its licensing.

### If AURA's distribution model changes

Stop and re-evaluate BEFORE distributing: either open-source the full
derivative work under AGPL-3.0 (including the Pine engine integration), or
obtain alternative licensing covering the intended model. Do not attempt to
circumvent the copyleft in either case.
