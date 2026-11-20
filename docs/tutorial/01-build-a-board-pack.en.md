# Building a board pack for an unfamiliar board

How to produce a board pack for a board that is not yet known to the
application. When it is done, the host can read that board's state and
change its behaviour.

The document serves two readers: a developer who wants to write a board
pack by hand, and an AI agent responsible for extending one. Both follow
the same path.

---

## Before you start

- The application is installed and running, and the board is connected.
- The application can reach the board over one of the transports.
- With a serial connection, you need the port name and the baud rate.

The application includes a board setup wizard that performs the whole
procedure. Doing it by hand is worth it when the probe range needs to be
controlled, or when the pack the wizard produced needs to be inspected.

---

## Why a generic pack exists

A board pack describes the capabilities of one board model: which tags
exist, where their data comes from, and which actions can be performed on
it. Tag sampling depends on the data sources declared in the pack, so a
board without a pack cannot be read.

`profiles/boards/generic-linux/` removes that dependency. It declares
paths that are conventions of Linux and sysfs rather than of one model:

| Data source | Path | Tags it provides |
|---|---|---|
| `cpu` | `/proc/stat`, `/proc/cpuinfo` | `cpu.usage`, `cpu.core.*.usage`, `cpu.core.*.cluster` |
| `mem` | `/proc/meminfo` | `mem.total_bytes`, `mem.used_bytes`, `mem.available_bytes`, `mem.usage` |
| `loadavg1`, `loadavg5`, `loadavg15` | `/proc/loadavg` | `custom.generic-linux.loadavg.*` |
| `model` | `/proc/device-tree/model` | `custom.generic-linux.board.model` |
| `osrelease` | `/etc/os-release` | `custom.generic-linux.sys.osrelease` |
| `kernel` | `/proc/version` | `custom.generic-linux.sys.kernel` |
| `uptime` | `/proc/uptime` | `custom.generic-linux.sys.uptime_seconds` |
| `thermal` | `/sys/class/thermal/thermal_zone*` | `custom.generic-linux.temp.zone.*` |
| `backlight` | `/sys/class/backlight/*/brightness` | `custom.generic-linux.backlight.brightness` |
| `led` | `/sys/class/leds/*/brightness` | `custom.generic-linux.led.brightness` |
| `net` | `/sys/class/net/*/address` | `custom.generic-linux.net.mac` |

The generic pack works on most embedded Linux boards. Its limitation is
naming: it cannot tell which temperature zone is the SoC, or which devfreq
node is the GPU. What it produces is therefore factual rather than
semantic.

---

## The steps

### One. Make a connection

Create a connection profile under `profiles/targets/`. A profile describes
how to reach the board and is independent of the board model.

```json
{
  "id": "my-board",
  "label": "My board",
  "transport": "serial",
  "options": { "port": "COM3", "baudrate": 1500000, "pty": true }
}
```

The `id` must be unique. `device_key` defaults to `id` and is what groups
the several connections to one board.

### Two. Probe with the generic pack

Point the generic pack at that connection and read every data source it
declares:

```bash
npm run probe:board -- --pack generic-linux --profile my-board
```

The output lists the data sources and their results:

```
✓ cpu            proc_stat        cpu.usage=0.45percent  cpu.core.0.cluster=A55 …
✓ mem            meminfo          mem.total_bytes=8302329856byte  mem.usage=5.76percent
✗ led            file_read        tag custom.generic-linux.led.brightness is error
```

A success means the path is available on this board. A failure means the
path is absent, the way of reading it does not apply, or the permission is
missing.

Failures have three causes, and each one needs a different response:

- The path does not exist: the board has no such hardware, and the data
  source is dropped from the result.
- The path exists but the way of reading it does not apply: the generic
  pack's assumption is wrong, and that board needs its own data source.
- The permission is missing: run the probe again as root.

### Three. Write the first pack

Turn the probe results into a board pack. Keep the data sources that
succeeded and drop the ones that failed.

```yaml
apiVersion: devboard/v1
kind: BoardPack

id: my-board
name: My board
version: 1.0.0

requires:
  transports: [serial, adb]
  capabilities: [shell, exec]
  min_contract: devboard/v1

match:
  mode: substring
  models:
    - MyBoard

poll_groups:
  - id: fast
    interval_ms: 1000
    readers: [cpu]

  - id: slow
    interval_ms: 2000
    readers: [mem]

readers:
  - id: cpu
    kind: proc_stat
    args:
      stat_path: /proc/stat
      cpuinfo_path: /proc/cpuinfo
    provides:
      - tag: cpu.usage
        sample: usage
```

Two naming rules are worth knowing.

**The tag namespace.** A custom tag must carry the pack id as its prefix,
`custom.<pack id>.*`. Validation rejects anything else. The generic pack
uses `custom.generic-linux.`, so instantiation has to rewrite it.

**Poll groups.** Every data source belongs to exactly one group. The group
decides how often it is sampled: `/proc/stat` has to be read every second
because the usage is the difference between two samples, while the model
and the kernel version do not change within a day. Putting them in one
group means the slow values are read every second as well.

### Four. Validate

```bash
npm run validate:profiles -- profiles/boards/my-board
```

Validation covers 31 rules. An error means the pack cannot be used; a
warning means it can, but something deserves attention.

### Five. Make it available at runtime

Put the pack directory under `profiles/boards/`, or under `boards/` in the
user data directory. The user directory takes precedence.

The application scans the board pack directories at startup and chooses a
pack per connection in this order:

1. The connection profile names a pack, and that pack is used.
2. Otherwise the board model is read and matched against the `match.models`
   of each pack.
3. Zero or several matches means no pack is chosen, and the application
   says so rather than guessing.

Naming the pack in the connection profile therefore avoids the ambiguity
of automatic detection.

### Six. Verify

```bash
npm run probe:board -- --pack my-board --profile my-board
```

Every data source should succeed. The workbench then shows the board's
data.

---

## Completing the first pack

What the wizard and the manual probe produce is a first version. It is
accurate about facts: which capabilities exist, how many instances there
are, what shape the data has. It is not accurate about meaning: which
temperature zone is the SoC, whether a duty cycle is a utilisation.

Closing that gap needs two things: the board's manual, and further
probing. The usual work is:

- Confirm the temperature zone types from the manual and rewrite the
  `type_map` of the `thermal` data source, so that `temp.soc` and
  `temp.gpu` become separate tags.
- Confirm what the `load` file of a devfreq node means, and state it with
  `measure: utilization` or `duty_cycle`.
- Define the actions that are specific to this board, such as adjusting
  the backlight or switching an LED.
- Add the hardware that only this model has, such as a MIPI camera node.

Run the validation and the probe again after each change.

---

## Related documents

| Document | Contents |
|---|---|
| [Board pack format](../spec/02-board-pack.md) | The full field definitions and the 31 validation rules |
| [Tag contract](../spec/01-tag-contract.md) | The vocabulary, the namespaces and the five states of a tag |
| [Device facts](../02-device-facts.md) | Measured paths and behavioural constraints of a real board |
