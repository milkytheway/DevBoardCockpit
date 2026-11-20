# rk3588-atk

The board pack for the ATK-DLRK3588 (Alientek).

## What the board is

RK3588, Buildroot 6.1.141, 8 cores (Cortex-A55 x4 + Cortex-A76 x4). The
board's USB is claimed by the host, so it can be reached with the host's
`adb.exe` without a VMware passthrough.

## Where the paths come from

From the measurements recorded in the device fact list, `docs/02-device-facts.md`, and from
the documentation of the previous project.

One path was wrong when the pack was first written and was corrected
afterwards. The three traps below are encoded in the pack deliberately.

## Three traps encoded in the pack

### One. The NPU devfreq load file is not a utilisation

`/sys/class/devfreq/fdab0000.npu/load` reads `100@1000000000Hz`, and it
reads 100 while the board is idle. That is the clock duty cycle, not the
utilisation. An idle board would otherwise appear to be fully busy.

`npu.usage` therefore comes from `rknpu_load`, which reads
`/sys/kernel/debug/rknpu/load` and reports
`NPU load: Core0: 0%, Core1: 0%, Core2: 0%`.

The devfreq chain is exposed as a board-private quantity so that a card can
compare the two:

| Tag | Source | Meaning | Value while idle |
|---|---|---|---|
| `npu.usage` | rknpu debugfs | the real utilisation | 0% |
| `custom.rk3588-atk.npu.duty` | devfreq `load` | the clock duty cycle | 100% |
| `custom.rk3588-atk.npu.freq_hz` | devfreq `cur_freq` | the current frequency | 1000000000 |

The three come from different places. The `@<freq>Hz` inside `load` says
which frequency the duty cycle was measured at, not the current frequency,
so the duty is bound to the duty and the frequency is read separately.
Read together they distinguish an idle board running at full clock from a
board under load.

The devfreq chain declares `measure: duty_cycle`, which makes the validator
reject publishing a duty cycle as a utilisation.

### Two. `thermal_zone5` is not a stable index

The index points at a different zone on another board or another kernel
version. On this board it is `gpu-thermal`. The pack walks the directory
with a glob and merges the entries by their type file, so it does not read
the wrong zone on a different board.

### Three. `/sys/kernel/debug` is not guaranteed to be mounted

The NPU reading depends on it. Whether it is mounted comes from the board's
`/etc/fstab` and its init scripts, and it does not persist: it was mounted
on this board, but a reboot may lose it.

When it is missing, `npu.usage` reports `unavailable` rather than falling
back to the devfreq duty cycle, because that fallback would report 100%
while the board is idle.

## Verifying the pack

```bash
# the board is attached over the host's adb
npm run probe:board

# choose the pack (id or directory) and the connection profile
npm run probe:board -- --pack rk3588-atk --profile board-adb
```

The probe samples twice, because the CPU usage is the difference between
two samples, and then prints the value and state of every tag of every
reader. A tag that cannot be read is reported as missing rather than as
zero.

## Not verified

The two actions of this pack, `backlight.set` and `cpu.governor.set`, use
the general Linux sysfs paths. The paths were confirmed to exist; writing
through them was not tested. Both are reversible, both have a readback and
both have a parameter range, so a wrong path produces an error rather than
damage.

This board has two backlight instances,
`/sys/class/backlight/backlight/` and
`/sys/class/backlight/backlight1/`. The directory name is `backlight`, not
`backlight0`.
