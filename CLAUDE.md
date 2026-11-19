# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This is the backend for "Pizza Pulse" (GitHub: `taslimul6/Pizza-Pulse-Server`). It is an early-stage Express API; the companion frontend (Next.js, dev on port 3000) lives in the sibling directory `../pizza-hub`.

## Stack

- Node.js, **ES modules** (`"type": "module"` in package.json) — use `import`/`export`, and include the `.js` extension in relative imports (e.g. `./routes/index.js`).
- **Express 5** — async route handlers that reject are forwarded to error middleware automatically; path syntax follows path-to-regexp v8 (e.g. wildcards must be named: `/*splat`).
- **better-auth** for authentication.
- **cors** for cross-origin requests from the frontend.

## Commands

- Install: `npm install`
- Dev (auto-restart): `npm run dev`
- Run: `npm start`
- `.env` is loaded by `dotenv` (`dotenv.config()` near the top of `index.js`). With ESM, imports run before that call, so imported modules must not read `process.env` at load time — read it inside functions, or switch back to `import "dotenv/config"` as the first import; see `.env.example`.
- Tests: none configured — `npm test` currently exits with an error by design.

## Architecture

- `index.js` sets up the Express app (CORS → JSON body → routes → 404 → error handler) and starts listening.
- API routes are mounted under `/api` from `src/routes/index.js`; add new feature routers there.
- `src/middleware/errors.js` holds the 404 and central error handler. Throw/reject with an error carrying `status` to set the HTTP code; 5xx messages are hidden when `NODE_ENV=production`.
- CORS allows `CLIENT_URL` with credentials (needed for better-auth cookies).

## Notes

- `README.md` is saved as UTF-16; re-save as UTF-8 if editing it with tools that expect UTF-8.
- Secrets (e.g. `BETTER_AUTH_SECRET`, database URLs) belong in `.env`, which is gitignored.
