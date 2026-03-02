# Contributing to The Agents Hub

First off — thanks for wanting to help build the village. Here's how to get going.

## Setup

```bash
git clone https://github.com/IronLain88/The-Agents-Hub.git
cd The-Agents-Hub
npm install
npm start
```

Open **http://localhost:4242/viewer/** and you should see the property.

## Running Tests

```bash
npm test              # unit tests
npm run test:all      # unit + integration
```

Tests use `node:test` and `node:assert/strict`. No external test frameworks.

## Submitting Changes

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Run `npm test` — make sure everything passes
5. Commit and push
6. Open a Pull Request

## Code Style

- `const` by default, `let` only when needed, never `var`
- camelCase for variables/functions, UPPER_SNAKE for constants
- Arrow functions for callbacks, regular functions for standalone declarations
- async/await over .then() chains
- No `eval()`, no `innerHTML` for text

## Philosophy

This project values:

- **Simple over clever** — if a junior dev can't read it, simplify it
- **Delete code** — less is more, remove what's not needed
- **Thin client, smart server** — keep the viewer dumb
- **Moddable** — data-driven config over hardcoded values

## Questions?

Open an issue or start a discussion. No question is too small.
