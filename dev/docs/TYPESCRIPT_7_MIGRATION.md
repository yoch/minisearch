# TypeScript 7 migration — current dual-stack and future unification

Internal note for maintainers. Not part of the published npm package or GitHub Pages docs.

## Current state (branch / Unreleased)

This repo runs a **dual-stack** because TypeScript 7.0 ships a native Go `tsc` but **no stable programmatic API**. Tools that `import` / `require('typescript')` must keep TypeScript 6 until 7.1 (and ecosystem adoption).

| Package alias | Resolves to | Role |
|---|---|---|
| `typescript-7` | `npm:typescript@^7` | Native CLI → `pnpm exec tsc` / `make typecheck` |
| `typescript` | `npm:@typescript/typescript6@^6` | Programmatic API + `tsc6` for Rollup, TypeDoc, ESLint, knip |

`tsconfig.json` is already aligned for 6 and 7:

- `moduleResolution: "bundler"` (not legacy `"node"`; not `"nodenext"` — relative imports omit `.js`)
- `rootDir: "./src"`, `types: ["node"]`
- `isolatedModules: true`, `stableTypeOrdering: true`
- no `downlevelIteration`, no `ignoreDeprecations`

See also the short summary in [`AGENTS.md`](../../AGENTS.md).

## Why not a single `typescript@7` today

These consumers need the TypeScript 6 compiler API and would break if `typescript` pointed only at 7.0:

- `@rollup/plugin-typescript`
- `rollup-plugin-dts`
- TypeDoc
- typescript-eslint (via neostandard)
- knip

Vitest / tsx transpile via esbuild and do not need the native API.

## Measured local gains (2026-07-13)

On this codebase (`tsc --noEmit` over `src/` only):

| Binary | Version | Wall time (approx.) |
|---|---|---|
| `tsc` (native 7) | 7.0.2 | ~0.8–1.6 s |
| `tsc6` | 6.0.3 | ~3.1–5.9 s |

Roughly **3–4×** faster typecheck here (warm/cold variance included). Absolute CI savings stay modest because `tsc` is only one step of `make lint`; Rollup emit still uses the TypeScript 6 API.

## Future unification (after TypeScript 7.1+)

Do this only when **all** of the following are true:

1. TypeScript **7.1+** publishes a stable programmatic API.
2. **typescript-eslint**, **TypeDoc**, **rollup-plugin-dts**, **@rollup/plugin-typescript**, and **knip** declare support for that API (or viable replacements are chosen).
3. Local `make lint`, `make build`, `make docs-build`, `pnpm knip`, and `pnpm test` are green on a single `typescript@^7.1` install.

### Checklist

1. Set `"typescript": "^7.1.0"` (or whatever the supported range is) in `devDependencies`.
2. Remove `"typescript-7"` and the npm alias to `@typescript/typescript6`.
3. Remove `typescript-7` from `knip.json` → `ignoreDependencies`.
4. Update [`Makefile`](../../Makefile) comments / `make help` so typecheck no longer mentions dual-stack.
5. Update [`AGENTS.md`](../../AGENTS.md) and this document (mark unification done; keep a short history note).
6. Add a `CHANGELOG.md` entry under Unreleased / the next release.
7. Re-run: `make lint`, `make build`, `make docs-build`, `pnpm knip`, `pnpm test`, `node scripts/verify-npm-pack.cjs`.
8. Optionally re-time `tsc --noEmit` and note CI impact.

### Optional follow-ups (not required for unification)

- Point editor/workspace LSP at the single TypeScript 7 install (no dual language server).
- Consider transpile via esbuild/SWC for Rollup JS emit while keeping `tsc` for typecheck/declarations — only if build time becomes a bottleneck.

## Pitfalls to avoid

- Installing only `typescript@7` without keeping a 6.x API package for tooling.
- Switching to `moduleResolution: "nodenext"` without adding `.js` extensions on relative imports.
- Using `ignoreDeprecations: "6.0"` to hide config debt — those flags are hard errors under TypeScript 7.
- Expecting ×10 faster `make build`: the native speedup applies to the CLI typecheck path, not to plugins that still call the TypeScript 6 API.
