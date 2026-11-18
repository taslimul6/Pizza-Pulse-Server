# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This is the backend for "Pizza Pulse" (GitHub: `taslimul6/Pizza-Pulse-Server`). It is an early scaffold: `index.js` is empty and there is no source code, test suite, or linter yet. The companion frontend lives in the sibling directory `../pizza-hub`.

## Stack

- Node.js, **CommonJS** (`"type": "commonjs"` in package.json — use `require`/`module.exports`, not ESM `import`, unless the module type is changed).
- **Express 5** — async route handlers that reject are forwarded to error middleware automatically; path syntax follows path-to-regexp v8 (e.g. wildcards must be named: `/*splat`).
- **better-auth** for authentication. Note that better-auth is ESM-first; in CommonJS it may need dynamic `import()` or switching the package to `"type": "module"`.
- **cors** for cross-origin requests from the frontend.

## Commands

- Install: `npm install`
- Run: `node index.js` (no `start`/`dev` script defined yet)
- Tests: none configured — `npm test` currently exits with an error by design.

## Notes

- `README.md` is saved as UTF-16; re-save as UTF-8 if editing it with tools that expect UTF-8.
- Secrets (e.g. `BETTER_AUTH_SECRET`, database URLs) belong in `.env`, which is gitignored.
