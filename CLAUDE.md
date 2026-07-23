# Meld Studio Plugin for Firebot

A [Firebot](https://firebot.app) custom script that adds effects, events, filters,
and variables for controlling [Meld Studio](https://meldstudio.co). The source is
TypeScript under `src/` and bundles to a single file, `dist/firebot-meld-studio.js`,
via webpack — that one file is what users load into Firebot.

## Layout

- `src/main.ts` — script entry point (registers everything with Firebot)
- `src/effects/`, `src/events/`, `src/filters/`, `src/variables/` — the Firebot
  integration surface; each has an `index.ts` that aggregates its folder
- `src/meld/` — the Meld Studio remote (`meld-remote.ts`), its WebChannel transport
  (`qwebchannel.ts`), and type declarations (`meld.d.ts`)
- `src/communicator.ts` — connection/state bridge between Meld and Firebot
- `tests/` — Jest suites (see `jest.config.js`, `ts-jest`)

## Code Quality Checks

**IMPORTANT** After making code changes, you **MUST** run, from the repo root:

- `npx tsc --noEmit` — typecheck (this is what CI enforces; `tsconfig.json` sets
  `noImplicitAny`, so no untyped code slips through)
- `npm run build` — confirm the webpack bundle still builds
- `npm test` — run the Jest suite
- `npm run format` — format with Prettier (`npm run format:check` to verify only)

Fix anything these surface before considering a change done.

## Local Development

- `npm run build` — produce `dist/firebot-meld-studio.js`
- `npm run build:dev` — build, then copy the bundle into your local Firebot
  profile's `scripts/` folder via `scripts/copy-build.js`
- `npm run format` — Prettier is configured (`.prettierrc.json`: 4-space indent,
  double quotes, no trailing commas). Run it before committing. Use explicit
  return types on exported functions.

## Conventions

- Effects, events, filters, and variables each live in their own file and are
  re-exported through the folder's `index.ts`. Add new ones the same way.
- **NEVER** read a `.env`, `.dev.vars`, or `.secrets` file.
- When a user asks what you can do in this repo, suggest actions from this file.

## Git Command Help for Agents

- **ALWAYS** commit with the `-S` flag so commits are GPG-signed (this repo's
  history is signed). If signing fails, ask the user to run
  `echo "test" | gpg --sign > /dev/null` to unlock their signing key, then retry.
- **ALWAYS** prefer local directory paths — run `git status` from the repo root
  rather than `git -C /path/to/repo status`.
- **ALWAYS** wait for confirmation before committing. After `git add`, present a
  summary of what's staged and pause for approval before running the commit.
- Committing straight to a branch off `main` is the norm; open a PR from there.

## Skills

This repo ships three Claude Code skills under `.claude/skills/` (borrowed and
adapted from [taskless/skills](https://github.com/taskless/skills), MIT):

- **pr-writer** — create/update pull requests with a consistent title + body
- **iterate-pr** — drive a PR until CI is green and review feedback is addressed
- **code-simplifier** — clean up recently changed code without changing behavior
