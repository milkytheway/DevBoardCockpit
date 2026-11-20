# DevBoard Cockpit

A Windows desktop workbench for embedded Linux boards.

It standardises a board's capabilities as **semantic tags**, visualisation and control as **cards**, and extension through **MCP**, so that an AI agent running on the host can build instruments and switches on demand.

In essence this is SCADA / HMI software for embedded boards: tags are data sources, cards are graphic elements, and the configuration engineer is an AI.

[中文](README.md)

---

## Structure

| Layer | Contents | Location |
|---|---|---|
| Contract | Tag vocabulary, board pack format, card manifest, workflow pack format, MCP tool set | `docs/spec/` |
| Device facts | Measured paths and behavioural constraints of the ATK-DLRK3588 | `docs/02-device-facts.md` |
| Implementation | Electron main process, card host, tag runtime, workflow engine, MCP server | `src/` |
| Assets | Built-in cards, board packs, workflow packs, connection profiles | `cards/` `profiles/` |

The main process owns all device I/O, tag sampling, action execution and permission decisions. The renderer only draws. Cards run in isolated iframes and reach a whitelisted API only.

## Repository layout

```
docs/spec/               Contract: tag vocabulary, board pack, card manifest, MCP tools, workflow pack
docs/tutorial/           Methodology tutorials
docs/02-device-facts.md  Measured device facts
src/main/                Device I/O, tag runtime, action execution, card host, MCP server
src/renderer/            User interface
src/shared/              Types and theme shared by both processes
cards/                   Built-in cards
profiles/                Board packs, workflow packs, connection profiles
fixtures/                Real-device samples (golden test vectors, append-only)
scripts/                 Build, validation, generation and probing tools
tests/                   Unit, integration and end-to-end tests
```

---
## Getting started

Prerequisites: Node.js 20 or later; Windows. Development requires the Visual Studio build tools to compile `node-pty` and `serialport`.

```bash
git clone <repository-url>
cd DevBoardCockpit
npm install
npm run dev
```

To build an installer:

```bash
npm run dist
```

The result is `release/DevBoardCockpit-0.1.0-setup.exe`.

## Connecting a board

Three transports are configured independently. Connection profiles live in `profiles/targets/`:

| Transport | Purpose | Required fields |
|---|---|---|
| ADB | Debugging, file transfer | `serial` (board serial number) |
| Serial | Debug console | `port`, `baudrate` |
| SSH | Remote login | `host`, `username`, credentials |

`hostTools.adb` in `profiles/settings.json` points at the local adb executable. If unset, the application searches `PATH` and common install locations.

The default baud rate for this board is 1500000.

The application includes a **board setup wizard**: after choosing a transport and serial parameters, the wizard probes the board with the generic board pack (`profiles/boards/generic-linux/`), generates a matching board pack, and writes it to the user data directory. See the [tutorial](docs/tutorial/01-build-a-board-pack.en.md).

## Extending

All three extension paths require no change to the main process.

A **card** is a directory of HTML, JavaScript and styles declaring the tags and workflows it needs. Drop it into the user card directory; it takes effect on hot reload.

A **board pack** is a YAML file declaring the tag sources, actions and auto-detection rules for one board model.

A **workflow pack** is a YAML file declaring how to complete a multi-step task, possibly across machines.

An AI agent on the host reaches every capability through MCP, which exposes 20 tools covering tag reads, action execution, and card and workflow management. The MCP server listens on a local port when the application starts; the port and bearer token are written to `mcp.json` in the user data directory, which the agent reads to connect.

## Development

```bash
npm run lint          # ESLint
npm run typecheck     # TypeScript
npm test              # Vitest
npm run test:cards    # Playwright, real Electron
npm run validate:profiles   # Validate board packs
npm run check:package       # Validate build artefacts
```

Tests do not require hardware. Paths that do are covered separately by `npm run probe:board -- --profile <profile>`.

## Hardware requirements

Some features need real hardware:

- Tag sampling requires the board to be reachable
- The serial port must be free; when another process holds it, sampling times out
- File transfer requires ADB or SSH; serial cannot transfer files
- Some actions change board state, including rebooting

Dangerous actions are switched individually in settings and are off by default.

## Documentation

| Document | Contents |
|---|---|
| [Contract overview](docs/spec/00-overview.md) | Two main lines and the role of each document |
| [Tag contract](docs/spec/01-tag-contract.md) | Vocabulary, namespaces, five states |
| [Board pack format](docs/spec/02-board-pack.md) | Data sources, actions, validation rules |
| [Card manifest](docs/spec/03-card-manifest.md) | Manifest structure, permissions, sandbox |
| [MCP tool set](docs/spec/04-mcp-tools.md) | Tool definitions and return shapes |
| [Workflow pack format](docs/spec/05-workflow-pack.md) | Step kinds, roles, cancellation semantics |
| [Device facts](docs/02-device-facts.md) | Measured paths and behavioural constraints |
| [Tutorial](docs/tutorial/01-build-a-board-pack.en.md) | Building a board pack for an unfamiliar board |

## License

[MIT](LICENSE)
