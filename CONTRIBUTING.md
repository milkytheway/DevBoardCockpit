# Contributing

## Prerequisites

Node.js 20 or later. **No compiler is needed.** `node-pty` and `serialport` are NAPI modules: the prebuilt binaries that ship with them work across the Node and the Electron versions. The Visual Studio build tools are only needed in the rare case where a prebuilt binary does not fit the machine.

## Setup

```bash
npm install
npm test
```

`npm install` runs a postinstall step that checks the native modules: when they load (the usual case — the prebuilt binaries are used) nothing is compiled, and only when one of them does not fit the machine is it compiled from the source. That is the only case that needs a compiler.

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

## Versions and releases

**The version moves only for a release.** A fix, a document, a refactor or a
test leaves `package.json`'s `version` alone — a small commit does not
become a version.

**A tag is a release, and a release is a decision.** Cutting `v0.2.0` and
publishing the installer is the maintainer's call, not something a pull
request does on the way through.

- The version of `package.json` is the only version in the repository — the
  MCP server and the release read it, they never copy it.
- The tag must name the version of the package; `npm run release:check`
  refuses a tag that disagrees.
- The artefact name carries the version and the system
  (`DevBoardCockpit-<version>-win-x64-setup.exe`), so a downloaded file says
  what it is.
- A published tag is never moved. A correction goes into the next version.

The release workflow (`.github/workflows/release.yml`) builds the installer on
a tag push, checks the packaged artefact, writes `SHA256SUMS.txt` and
publishes both on the Releases page.

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
