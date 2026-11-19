# Contributing

## Prerequisites

Node.js 20 or later. On Windows, the Visual Studio build tools are required to compile the native modules `node-pty` and `serialport`.

## Setup

```bash
npm install
npm test
```

`npm install` runs a postinstall step that builds the native modules for the local Electron version. On a machine without the build tools, the install completes but the native modules will not load.

## Checks

Run all three before submitting:

```bash
npm run lint
npm run typecheck
npm test
```

The test suite covers paths that need a physical board and are skipped when it is absent. To exercise those paths, connect a board and run:

```bash
npm run probe:board -- --profile board-adb
```

## Commits

Commit messages are written in English and follow the conventional prefix format:

```
<type>(<scope>): <summary>
```

Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.

## Pull requests

1. Open an issue first for changes that alter the contract in `docs/spec/` or the public shape of any MCP tool.
2. Keep one concern per pull request.
3. State what the change does, how it was verified, and what a reviewer should check.

## Adding a card

Cards live in `cards/`. A card needs `manifest.json`, `index.html`, `card.js` and `style.css`. The manifest declares the tags and workflows the card requires; the card may not read anything it has not declared.

Styles must use the `--cockpit-*` variables the host injects. Hard-coded colour values are rejected by the test suite.

Card scripts run in a sandboxed iframe. They cannot access the filesystem or the network directly; host capabilities are reached through the `cockpit.*` API.

## Adding a board pack

Board packs live in `profiles/boards/`. Each is a directory containing `board.yaml`. Validate a new pack with:

```bash
npm run validate:profiles
```

`docs/spec/02-board-pack.md` defines the format and the 31 validation rules.

## Adding a workflow pack

Workflow packs live in `profiles/workflows/`. The format and the permitted step kinds are defined in `docs/spec/05-workflow-pack.md`.

## Licence

Contributions are accepted under the [MIT licence](LICENSE).
