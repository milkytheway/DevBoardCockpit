# Device facts

> Migrated from the previous project, `DevBoardConsole`, and reviewed
> line by line against real hardware in November 2026.
> This is the document the project cannot lose. The previous Python code can
> be discarded; the facts recorded here cannot.
> Read it before writing a parser, a transport or a tag binding.

## 0. How to read it

| Mark | Meaning |
|---|---|
| 🟢 | Measured on this machine; the evidence or the command to repeat it is given |
| 🟡 | Reported by the user or recorded by the previous project; not independently confirmed |
| 🔵 | Not verified yet; the command to verify it is given |

The upstream source is the notes of the earlier study environment. The
measurements there are where this list comes from, but this list is what
counts.

---

## 1. The board

| Item | Value | Mark | Evidence |
|---|---|---|---|
| Model | `ATK-DLRK3588 Board` | 🟢 | `rk3588-alientek.dtsi:22` |
| compatible | `rockchip,rk3588-evb7-lp4-v10`, `rockchip,rk3588` | 🟢 | `rk3588-alientek.dtsi:23` |
| Distribution | Buildroot 2024.02 (`NAME=Buildroot`) | 🟢 | `adb shell cat /etc/os-release` |
| rootfs version | `VERSION=-g06c38152` | 🟢 | as above |
| Kernel | `6.1.141` | 🟢 | `adb shell uname -r` |
| init | BusyBox init + eudev 3.2.14, no systemd | 🟢 | boot-time log + `ps` |
| CPU | 8 cores = A55×4 (CPU part 0xd05) + A76×4 (CPU part 0xd0b) | 🟢 | `grep CPU part /proc/cpuinfo` |
| Memory | `MemTotal: 8107744 kB` (about 7.7 GiB) | 🟢 | `adb shell grep MemTotal /proc/meminfo` |
| User-space tools | `ls` is GNU coreutils, not BusyBox | 🟢 | `ls -l /bin/ls` |
| Python on the board | 3.11.8 | 🟡 | measurement recorded in the earlier study environment |
| eth0 address | `192.168.5.100/24` (the host physical segment) | 🟢 | `adb shell ip -4 addr show` (2026-11-15) |

> ⚠️ Note the combination of the last two rows: init is BusyBox, but the user-space tools are coreutils.
> That directly decides which commands support `--color` and which support `-C`.

## 2. The three transports (host side)

| Transport | Target | Parameters | Mark |
|---|---|---|---|
| ADB | the board | board serial `0000000000000000`, state `device` | 🟢 `adb devices -l` |
| Serial | the board | host `COM3` (CH343 USB-UART), 1500000 baud | 🟢 PnP enumeration |
| SSH | the board | `192.168.5.100:22`, user `root`, key `~/.ssh/id_ed25519_codex_board` | 🟢 measured 2026-11-21 (the handshake answers ✓) |
| SSH | Ubuntu guest (VMware) | `192.168.136.131:22`, user `alientek`, key `~/.ssh/id_ed25519_codex_vm` | 🟢 measured 2026-11-21 (the old `192.168.100.10` was the VMware NAT gateway — not the guest — 🟡 from the previous project) |
| Local | the host itself | — | 🟢 |

The host adb path (not on PATH, `where adb` cannot find it):

```
C:\Users\<user>\Downloads\platform-tools_r33.0.3-windows\platform-tools\adb.exe
```

> The previous project hardcoded it in the candidate list at `core/adb_target.py:46`.
> The new project should keep it in `profiles/settings.json`, not in the code (AGENTS.md rule: paths belong in configuration).

## 3. Readable paths on the board and reading formats (the raw material for tags)

> ⚠️ The contract names follow the core vocabulary in `docs/spec/01-tag-contract.md`; this document gives only the facts (paths, formats, measured values).
> Where the two disagree, this document wins, and the difference is recorded in the contract cross-check list.
>
> 📁 The raw samples are in `fixtures/board/` (collected straight off the board on 2026-11-13):
> `ls -la /`, a snapshot from one round trip, a comparison of the two NPU paths, and two real samples of `/proc/stat`.
> The item-by-item conclusions are in the contract cross-check list.

| Contract name | Path | Raw format | Measured / Notes |
|---|---|---|---|
| `cpu.usage` | `/proc/stat` | `cpu  25288 0 16570 41447116 …` | busy = user + system + … (idle excluded); the value is the difference between two samples, the first reading is `pending` |
| `cpu.core.*.usage` | `/proc/stat` | `cpu0 15399 0 4709 5163405 …` | the core index is the N of `cpuN`, not the counter |
| `cpu.core.*.cluster` | `/proc/cpuinfo` | `CPU part	: 0xd05` | 🟢 0xd05=A55 ×4, 0xd0b=A76 ×4 |
| `gpu.usage` | `/sys/class/devfreq/fb000000.gpu/load` | `0@300000000Hz` (idle) | 🟡 reads 0 when idle (the opposite of the NPU's 100) → it looks like a busy ratio, but there is no sample taken under load, so it cannot be treated as proven |
| `gpu.freq_hz` | same as above | same as above | the frequency part, unit Hz |
| `npu.usage` | `/sys/kernel/debug/rknpu/load` | `NPU load:  Core0: 0%, Core1: 0%, Core2: 0%,` | 🟢 real load, 3 compute cores, take the max |
| `mem.total_bytes` | `/proc/meminfo` | `MemTotal:        8107744 kB` | 🟢 the source unit is kB, the reader must multiply by 1024 |
| `mem.used_bytes` | `/proc/meminfo` | `MemTotal - MemAvailable` | 🟢 measured MemAvailable 7655664 kB (another sample gave 6104320 kB, see `fixtures/metrics/snapshot-sample.txt` — different moments, not a contradiction) |
| `mem.usage` | same as above | derived | |
| `temp.soc` | `/sys/class/thermal/thermal_zone*/{type,temp}` | millidegrees Celsius, e.g. `32384` | group by `type`, not by the zone index |
| `temp.gpu` | same as above | `31461` → 31.461 °C | 🟢 `thermal_zone5` = `gpu-thermal` |

> ⚠️ The evidence that the three temperatures are independent ✓ — it is structural ✓ (not "the values happen to differ" ✓):
>
> | zone | `type` | `temp` measured on 2026-11-16 | Who reads it |
> |---|---|---|---|
> | `thermal_zone0` | `soc-thermal` ✓ | 34230 (34.230 °C ✓) | `temp.soc` ✓ |
> | `thermal_zone5` | `gpu-thermal` ✓ | 33307 (33.307 °C ✓) | `temp.gpu` ✓ |
> | `thermal_zone6` | `npu-thermal` ✓ | 33307 (33.307 °C ✓) | `temp.npu` ✓ |
>
> → Three different `type` names ✓ → grouping matches on `type`, not on the index ✓ (that is the rule itself ✓) →
> → the three tags read three different sensors ✓ → they are independent of each other ✓
> → and at the same moment the SoC and the GPU/NPU readings really do differ ✓ (34.230 vs 33.307 ✓)
| `temp.npu` | same as above | millidegrees Celsius | the type name is `npu-thermal` |
| `board.model` | `/proc/device-tree/model` | `ATK-DLRK3588 Board\0` | 🟢 measured; there is a NUL at the end, strip it |

### 3.1 Board-private quantities (not in the core vocabulary)

| Fact | Path | Measured | Notes |
|---|---|---|---|
| Backlight 1 | `/sys/class/backlight/backlight/brightness` | `200` (max 255) | ⚠️ the directory name is `backlight`, not `backlight0` |
| Backlight 2 | `/sys/class/backlight/backlight1/brightness` | `255` (max 255) | the second screen (`platform/backlight1`); the core vocabulary defines only one backlight → see item C2 in the contract cross-check list |
| CPU scaling policy | `/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor` | `schedutil` | optional: interactive conservative ondemand userspace powersave performance schedutil. 🟢 the write was verified on the real board on 2026-11-13: write `ondemand` → read back `schedutil`, rc=0, no hang (E6) — it goes through cpufreq, which is not the same driver as devfreq, so the risk is different |
| NPU scaling policy | `/sys/class/devfreq/fdab0000.npu/governor` | `rknpu_ondemand` | 🟢 measured (2026-11-13): the `available_governors` of that node = `rknpu_ondemand dmc_ondemand vop2_ondemand venc_ondemand userspace powersave performance simple_ondemand` — only the first one belongs to the NPU itself, the rest are the global rkdevfreq list (it holds the dmc/vop2/venc entries and the cpufreq general ones). ⚠️ writing this node locks the board up — see §3.4 |
| NPU current frequency | `/sys/class/devfreq/fdab0000.npu/cur_freq` | `1000000000` | 🟢 measured to exist (always available under sysfs, no debugfs needed). The path written in the board pack of the previous project, `…/rknpu/devfreq/cur_freq`, does not exist → see item C1 in the contract cross-check list |
| NPU duty cycle | `/sys/class/devfreq/fdab0000.npu/load` | `100@1000000000Hz` | ⚠️ a duty cycle, not a utilisation figure; on an idle board it is 100 |
| NPU frequency | `/sys/kernel/debug/rknpu/freq` | `1000000000` | ⚠️ the path written in the board pack of the previous project, `…/rknpu/devfreq/cur_freq`, does not exist on this board → see item C1 in the contract cross-check list |

### 3.2 The complete set of devfreq nodes on the board (🟢 measured)

```
dmc  fb000000.gpu  fdab0000.npu  fdbd0000.rkvenc-core  fdbe0000.rkvenc-core  fdd90000.vop
```

`dmc` (DDR), `vop` (display output) and `rkvenc-core` (video encoder) are not wired to a tag yet,
but they are good candidates for components (memory bandwidth, display modes, encoding load).

### 3.3 The debugfs and rknpu directories (🟢 measured)

```
$ grep debugfs /proc/mounts
debugfs /sys/kernel/debug debugfs rw,relatime 0 0      ← currently mounted

$ ls /sys/kernel/debug/rknpu/
delayms  freq  load  power  reset  version  volt        ← no devfreq/ subdirectory
```

- `npu.usage` depends on debugfs; the mount is not persistent (it can be lost after a reboot),
  so "cannot be read" must be reported as `unavailable` with the reason, not by falling back to the duty cycle.
- `rknpu/load` puts all cores on one line (`Core0: …, Core1: …`), which matches `npu.core.*.usage`.

### 3.4 The devfreq write path, measured (2026-11-13, E1–E6) 🟢

> This section is the factual basis for "do not let an agent touch the devfreq write path".
> Board serial `0000000000000000`, `adb push` of a script plus `adb shell sh`,
> with no shell interpolation (to avoid local expansion).

| # | Measurement | Conclusion |
|---|---|---|
| E1 | the `available_governors` of `fdab0000.npu` and `dmc` are exactly the same (9 values: `rknpu_ondemand dmc_ondemand vop2_ondemand venc_ondemand userspace powersave performance simple_ondemand`) | this list is the global union at the rkdevfreq class level; it carries no information for a single node |
| E2 | writing `dmc_ondemand` and `powersave` to `fdab0000.npu/governor`: rc=0, no error at all, the old value is read back | the node accepts any value in the list. The list does not tell you which value means something for this node |
| E3 | while writing to `fdab0000.npu/governor`, `dmc/governor` stays `dmc_ondemand` (two independent observations) | the current value is per node, not global. ⚠️ the earlier document said "writing it changes other modules" — that is wrong, only the list of available values is global |
| E4 | writing `powersave` to the NPU node → the write call hangs: `/proc/<pid>/wchan = devfreq_monitor_stop`, the process enters state D, `kill -9` has no effect. From then on every governor read and write on that node and every `trans_stat` read block in state D | 🔴 switching a devfreq governor risks a kernel deadlock, and it is unrecoverable — only a reboot saves the board. The same order was run once without a hang → it is a race, not a certainty. One occurrence is enough to lock the board up |
| E5 | the permission bits of `fdab0000.npu/cur_freq` are `-r--r--r--` (even root cannot write into it) | the `userspace` governor has no usable meaning on this board: it means "the user space sets the frequency", and the user space has no write permission. Choosing `userspace` is in practice switching off automatic scaling |
| E6 | writing `ondemand` through the path `cpu.governor.set` uses (cpufreq `scaling_governor`) → `schedutil`: rc=0, no hang, the read-back agrees | the existing `cpu.governor.set` goes through cpufreq (not the same driver as devfreq), the risk is different and it is clean today. This action had never been verified on real hardware before; this round verified it |

How this table is used:

1. `npu.governor.set` does not go into the board pack (ADR-D26) — the reason is not "we are unsure of its semantics" but the
   measurement that it locks the board up and cannot be recovered from.
2. `cpu.governor.set` is kept — it goes through a different driver and measured clean.
3. The answer for O15 is the single value `rknpu_ondemand` — E1 and E2 prove that the list cannot yield the correct enumeration.
4. Risk boundary: E4 covers the devfreq class nodes (`fdab0000.npu`, `dmc`, `fb000000.gpu`…),
   and does not cover the cpufreq nodes.

> Board state disclosure: at the start of this round the NPU governor was already `userspace` (not the power-on default
> `rknpu_ondemand`) — a previous session wrote it and did not restore it.
> That is exactly a real sample of "an agent can write a governor and nobody watches it get restored".
> At the end of this round it was restored to `rknpu_ondemand` (the power-on default), `dmc/governor` was unaffected, and the full re-check passed.
>
> Incidentally: the hung state of E4 could at that time only be cleared by a reboot —
> which is itself the hardest evidence for E4.

---

### 3.5 Where the artefacts go (where the build output goes, how to install it, how to run it) 🟢 measured (2026-11-15)

> Why it is on this list: placement is a rule of the board (not a requirement of the workflow) —
> changing board model can change the rule, so the rule belongs to the board pack and this list, and the workflow only says "install it to the kernel module location".
> Before 2026-11-15 these facts existed only in the earlier study environment (🟡); three independent reviews all asked for them to be pinned down here.

| Artefact | Placement | Mark | Evidence |
|---|---|---|---|
| a `.ko` you built yourself | `/usr/lib/modules/<kernel version>/extra/` | 🟢 | `ls -d /usr/lib/modules/*/` → `/usr/lib/modules/6.1.141/`; the `extra/` directory exists under it |
| an executable you built yourself | `/usr/local/bin/` | 🟢 | the earlier study environment, placement rules, section 1 (the same rules, whose path conventions agree with the measurements on the board) |
| Kernel version | `6.1.141` | 🟢 | `uname -r` |
| Loading tools | `modprobe` / `depmod` / `insmod`, all of them in `/usr/sbin/` | 🟢 | `which modprobe depmod insmod` |

The hard rules (the normal flow for installing a `.ko`) — basis: the earlier study environment, placement rules, section 4 (its paths agree with the measurements of §3.5 of this list) plus the measurements of this list:

| # | Rule | Mark |
|---|---|---|
| P1 | ❌ do not put a `.ko` into `/root` or `/tmp` → put it into `extra/` | 🟢 |
| P2 | ❌ do not use `insmod /path/x.ko` as the normal flow → install it into `extra/` + `depmod -a` + `modprobe <name>` (load it by name, no path needed — which is exactly the benefit of installing it into `extra/`) | 🟢 |
| P3 | ❌ after installing a `.ko`, do not forget `depmod -a` — without that step `modprobe` reports "not found" | 🟢 |
| P4 | ❌ what `adb push` transfers has the permissions `-rw-rw-rw-` → the program has to `chmod +x` itself | 🟢 |
| P5 | ⚠️ `depmod -a` rebuilds the whole index → run it once after you have fully pushed your own `.ko`, and do not push modules concurrently | 🟢 |

The re-check commands (run on the host):

```powershell
adb shell uname -r
adb shell ls -d /usr/lib/modules/*/
adb shell ls /usr/lib/modules/$(adb shell uname -r | tr -d '\r')/ | head
adb shell which modprobe depmod insmod
```

---

## 4. Behavioural traps, by transport

### 4.1 ADB

| # | Trap | Symptom | Countermeasure | Mark |
|---|---|---|---|---|
| A1 | do not use a PTY | `adb shell -t -t` holds the reply back until the next command, which shows up as "one command late" | use `adb shell` (no PTY), draw your own prompt, do your own line editing | 🟢 measured in the previous project |
| A2 | `TERM=dumb` | adb sets `TERM` to `dumb`, GNU coreutils then refuses to colour the output (`--color=always` does not help either) | `export TERM=xterm-256color` when the session starts | 🟢 |
| A3 | aliases do not take effect | a non-interactive shell does not expand aliases, `alias ls='ls --color=auto'` fails silently | use a shell function instead: `ls() { command ls -C --color=always "$@"; }` | 🟢 |
| A4 | `-C` layout | without `-C` coreutils prints one entry per line; with `-l`/`-1` it falls back to one per line on its own | `-C`, and colour only the commands meant for humans; piped commands go out unchanged | 🟢 |
| A5 | one `adb shell` per command ≈ 30 ms | sampling metrics file by file is slow | merge them into a single snapshot script round trip | 🟢 |
| A6 | the CPU time of the fork pollutes `/proc/stat` | reading file by file makes the board look 100% busy | as A5: it must be one round trip | 🟢 |
| A7 | only the `device` state counts | `adb devices` can show `offline`/`unauthorized` | filter `parts[1] == "device"` | 🟢 |
| A8 | output decoding | the board is UTF-8 Buildroot, but there can be stray bytes | `decode('utf-8', 'replace')`, never let one bad byte throw away a whole command | 🟢 |

### 4.2 Serial (UART)

| # | Trap | Symptom | Countermeasure | Mark |
|---|---|---|---|---|
| S1 | single channel | the command channel and the interactive terminal share one wire | one read thread + one transcript; a command claims its own reply through a marker | 🟢 |
| S2 | marker protocol | the board echoes the command, so the marker appears twice in the transcript (once on the echo line, once after the output) | take the content between "the newline after the first occurrence" and "the second occurrence" | 🟢 |
| S3 | marker format | it has to be unique every time | `__DBC<pid>_<millisecond timestamp>__`; it must be scrubbed out of the transcript before the text goes to the user | 🟢 |
| S4 | getty expects CR | sending only `\n` may not produce a line break | send `\n` → `\r\n` | 🟢 |
| S5 | no exit code | the serial port cannot return an exit status | a textual reply = 0; a timeout = 124 | 🟢 |
| S6 | one line at a time | the serial line buffer cannot swallow a multi-line script | metric sampling needs a single-line variant (the `supports_script=False` branch of the previous project) | 🟢 |
| S7 | no file transfer | sending files over UART is meaningless | `capabilities()` does not include `files`, and the UI disables the file browser accordingly | 🟢 |
| S8 | port enumeration | PowerShell's `Win32_SerialPort` cannot list the CH343, but the port really is there | use pyserial's `list_ports` (the previous project already did this) | 🟢 |

### 4.3 The whole reading chain works over serial (2026-11-13) 🟢

`probe:board --profile board-serial` → all 11 readers green
(the first run timed out on 11/11 — the root cause was not the code: a `serial-server.py` left over on the host by the plan 1 acceptance run
had opened COM3 exclusively and swallowed the replies; after stopping it the same command was all green).

| Observation | Explanation |
|---|---|
| `cpu.usage=0.596%`, `cpu.core.0..3=A55` / `4..7=A76` | the same shape as the readings over adb (not the same values — the values change) |
| `mem.usage=5.524%`, `backlight=200/255`, `cpu.governor=schedutil` | agrees with the measurements of §3.1 |
| `custom.rk3588-atk.npu.duty=100` | the duty cycle is bound to `.duty`, not to `*.usage` — the hole that rule 3 blocks was not stepped into |

> This also proves one thing: the "one round trip, mutually exclusive" rule of contract §1.2.1 really works over serial —
> the combined command of the three readers is sent as one line (fact S6), the marker separates the three parts, and there is no cross-talk.

### 4.4 SSH

| # | Trap | Symptom | Countermeasure | Mark |
|---|---|---|---|---|
| H1 | `ssh.exe` cannot do password authentication in a script | the automated call fails | use paramiko (`ssh2` on the Node side) | 🟢 measured in the previous project |
| H2 | the guest is on VMware NAT, the board is on the host physical segment (192.168.5.0/24), the guest is on the NAT segment (192.168.136.0/24) | they are not on the same segment (do not assume they can reach each other directly). ⚠️ corrected by the measurement of 2026-11-15: the guest can ping the board's `192.168.5.100` and connect to it (ping 2 ms, port 22 reachable) — the network layer works (the NAT gateway can route to the host physical segment). What is really missing is the credential: what the guest uses to connect to the board (the guest's public key goes into the board's `/root/.ssh/authorized_keys`) — that is a destructive-level write | 🟢 measured in the sandbox (`ping 192.168.5.100` + `connect()`) |
| H3 | **a key is bound to the host it opens** | the board's key does not open the guest and the guest's key does not open the board — the handshake answers "All configured authentication methods failed" in both directions | the credential is a **machine-specific value** ✓ and it is **verified** against the host ✓ (the key that authenticates is the credential of that host ✓) | 🟢 measured 2026-11-21 (`id_ed25519_codex_board` → `root@192.168.5.100` ✓ · `id_ed25519_codex_vm` → `alientek@192.168.136.131` ✓ · crossed over ✗) |
| H4 | **the address of the guest is the one the person already reaches** | a connection that is not a board (the guest ✓) was pointing at the **board's** address — the board's answer for the guest ✓ and the guest's key does not open the board ✗ | the address of a machine that is not a board comes from the **person's own ssh records** ✓ (`~/.ssh/known_hosts` ✓ · `~/.ssh/config` ✓) — **the board's address never leaks into it** ✓ | 🟢 measured 2026-11-21 (`known_hosts` carries `192.168.136.131` ✓ · the guest's answer for the board ✗) |
| H5 | **"cannot reach the host" is three different problems** | the board **answered** ✓ and refused the key ✗ — and the interface said "cannot reach the SSH host" ✓ → the user looks for a network problem that does not exist ✗ | the failure names the kind ✓: the host did not answer ✓ · it answered and refused the credential ✓ · there was no credential at all ✓ | 🟢 measured 2026-11-21 |
| H6 | the handshake of ssh2 waits **20 seconds** by default | the interface says nothing for 20 seconds → **it looks like the application hangs** | `readyTimeout` ✓ (8 s ✓) | 🟢 measured 2026-11-21 |

### 4.5 General / host side

| # | Trap | Symptom | Countermeasure | Mark |
|---|---|---|---|---|
| G1 | timeout semantics | the timeouts of the different transports behave differently | return 124 in every case, the caller recognises that one meaning only | 🟢 previous project convention |
| G2 | unknown ≠ zero | "the board cannot be read" and "the board is idle" looking the same is a disaster | a missing metric is `unknown`, the UI shows `--`, never fill in 0 | 🟢 previous project design decision |
| G3 | the child process flashes a console window | on Windows a process launched by a GUI opens a console window by default; the previous project sampled metrics once a second → the screen flickered madly | child processes always use `CREATE_NO_WINDOW` / `windowsHide: true` on the Node side | 🟢 |
| G4 | session log | a crash, a restart or closing the window must not lose the record | every line goes to disk + flush; the ANSI codes are stripped; the path is `%LOCALAPPDATA%/<App>/logs/<date>/<label>-<HHMMSS>.log` | 🟢 |
| G5 | the terminal does not flow back | widening a VT terminal cannot restore the cells that were cut off | either do not resize, or accept the truncation | 🟢 measured with pyte in the previous project |
| G6 | **the path of the working tree must be plain ASCII** | the NSIS installer fails with *"Error writing temporary file. Make sure your temp folder is valid."* → the build dies **after** the 84 MB artefact was written (a stub of 188 KB is left behind ✓) → **the cause is the path, not the disk and not the temp folder** ✓ (both were checked ✓: 28 GB free ✓ · a short ASCII temp folder changed nothing ✓) | build from a path made of ASCII letters only ✓ (e.g. `C:\work\DevBoardCockpit` ✓) → the same tree ✓ the same node_modules ✓ and the installer is written in full ✓ (measured 2026-11-22 ✓: 84.0 MB ✓ · `npm run check:package` ✓) | 🟢 measured 2026-11-22 |

> **G6 in one sentence** ✓: the directory names of this repository live under
> `02、RK3588开发平台` ✓ (Chinese characters ✓ · a full-width comma ✓) — that
> is fine for the application ✓ (it reads the profiles and the cards ✓) but
> **not** for the NSIS installer ✓ → **the release workflow builds on a
> runner with an ASCII path** ✓ (`D:\a\DevBoardCockpit\DevBoardCockpit` ✓)
> → the published installer is complete ✓ ✓.

---

## 5. Conclusions that can be inherited directly from the previous project

These are the judgements the previous project paid for with real hardware; the new project does not have to verify them again, it inherits them directly:

1. The UI never touches the device directly, everything goes through one interface — this already holds, inherit it directly (it is the tag/action layering).
2. Capability negotiation drives the degradation of the UI: a target that does not support `files` has the file browser disabled automatically.
3. "How to connect" and "what it connects to" have to be kept apart — the previous project only did the former (target profile),
   while the board differences (paths such as `fb000000.gpu`) were still hardcoded in `metrics.py`.
   The new project must add the latter (board profile), and that is exactly the problem the tag contract is there to solve.
4. Metric sampling has to be one round trip (see A5/A6) — the parsing logic can be rewritten, but this constraint has to be inherited.
5. The `unknown` semantics (G2) — inherit.
6. The uniform timeout code 124 (G1) — inherit.
7. The session log format (G4) — inherit the format, and change the application name in the path to `DevBoardCockpit`.

### 3.6 2026-11-16 · board measurements after the cross-check against the manual (the basis for extending the meta-operations and the workflow packs) 🟢

> Basis: chapter 2 of the ALIENTEK ATK-DLRK3588_Buildroot System Quick Experience Manual V1.0
> and its functional test matrix, plus a line-by-line re-verification on the real board (`0000000000000000`) on 2026-11-16.
> The detailed list is in the meta-operations and workflow pack extension notes shipped with this project.

#### 3.6.1 CPU frequency scaling is policy-based, not cpu-based 🟢

| Fact | Value |
|---|---|
| Policy nodes | `policy0` / `policy4` / `policy6` (only three ✓) |
| `policy0` | cores 0-3 (the A55 little cores ✓) |
| `policy4` | cores 4-5 (the A76 big cores ✓) |
| `policy6` | cores 6-7 (the A76 big cores ✓) |
| `cpu{N}/cpufreq` | is a symlink → points at `../cpufreq/policyN` ✓ |
| Available governors | `performance schedutil powersave ondemand userspace interactive conservative` ✓ |
| Measured frequency range | little cores 408000–1800000 ✓ · big cores 408000–2256000 ✓ |

> ⚠️ Writing `cpu0` actually writes `policy0` ✓ → it governs only 4 cores ✓.
> Manual §2.17 explicitly says "enabling all cores is recommended" ✓ → hence there is a `cpu.governor.set_all` ✓.

#### 3.6.2 The system time of the board is 1970-01-01 🟢

| Fact | Value |
|---|---|
| `date` | `1970-01-01 12:43:24` ✓ |
| `hwclock` | `hwclock: RTC_RD_TIME: Invalid argument` ✓ (the RTC cannot be read ✓) |
| `/dev/rtc0` | exists ✓ (the node is there ✓) |
| `/sys/class/rtc/rtc0/name` | exists ✓ → the vendor's `rtc_test.sh` therefore passed ✓ (it only checks that the node exists ✓) |

> → The RTC node is there, but the time cannot be read ✓ → the board has no usable absolute time ✓.
> → The factory system has NTP (manual §2.6 ✓), but without a network it is wrong ✓.
> → So "setting the system time" is a real requirement ✓ (`sysclock.set` ✓),
> while `hwclock.write` is useless on this board ✗ → it was not made into an action ✓.

#### 3.6.3 The on-board LED: writing the brightness has no effect in heartbeat mode 🟢

| Fact | Value |
|---|---|
| Node | `/sys/class/leds/work/` ✓ |
| Factory `trigger` | `heartbeat` ✓ |
| Writing `brightness` directly | it still reads back as 0 ✓ (the value is decided by the trigger ✓) |
| The correct way | first `echo none > trigger`, then write the brightness ✓ → it reads back as 1 ✓ |

> Manual §2.1 describes exactly these two steps ✓.→ `led.set` writes them as one command ✓.

#### 3.6.4 The measured list of the on-board tools 🟢 (everything the manual uses is there)

`hdparm` `iperf3`(3.14) `dd` `evtest` `amixer` `arecord` `aplay` `gst-play-1.0`
`gst-launch-1.0` `cansend` `candump` `ip` `rfkill` `wpa_supplicant` `connmanctl`
`hciconfig` `hcitool` `ifconfig` `depmod` `modprobe` `insmod` `rmmod` `lsmod`
`scp` `ssh` `dmesg` `hexdump` `od` `xxd` `pkill` `v4l2-ctl` `hwclock` `date` ✓

#### 3.6.5 The vendor factory self-test scripts on the board 🟢

`/opt/ui/src/apps/resource/pcba/ATK-DLRK3588/` ✓ — this is what the factory test app uses ✓.

| Script | Measured result |
|---|---|
| `cpufre_test.sh` | ✅ pass ✓ (checks whether `cpuinfo_cur_freq` of the three policies is there ✓) |
| `eth0_test.sh` | ✅ pass ✓ (eth0 has an IP ✓) |
| `eth1_test.sh` | ❌ fail ✓ (no Ethernet cable plugged into eth1 ✓) |
| `wifi_test.sh` | ✅ pass ✓ |
| `bluetooth_test.sh` | ✅ pass ✓ (`hci0` UP RUNNING ✓) |
| `rtc_test.sh` | ✅ pass ✓ (but it only checks that the node exists ✓ — that is not a contradiction with `hwclock` failing ✓) |
| `sdcard_test.sh` | ❌ fail ✓ (no TF card inserted ✓) |

> ⚠️ `mic_test.sh` / `loudspeaker_test.sh` are `for i in {1..1000}` infinite loops ✓
> → do not list them in a workflow ✓ (one run takes tens of minutes ✓).

#### 3.6.6 The node mapping of the MIPI CSI cameras 🟢

The silkscreen of manual §2.8 ↔ the nodes ✓ (all four nodes really report the name `rkisp_mainpath` ✓
→ the model cannot be recognised from them ✓ → only the silkscreen mapping can identify them ✓):

| Silkscreen | Node |
|---|---|
| MIPI CSI1 | `/dev/video62` ✓ |
| MIPI CSI2 | `/dev/video71` ✓ |
| MIPI CSI3 | `/dev/video44` ✓ |
| MIPI CSI4 | `/dev/video53` ✓ |

> `v4l2-ctl --list-devices` cannot be used ✓ — it goes and opens every device node ✓
> → a node with no camera plugged in makes the whole command fail ✓ (measured `Failed to open /dev/video0` ✓).
> → Read sysfs instead ✓ (`/sys/class/video4linux/video*/name` ✓) — it does not touch the device nodes ✓.

#### 3.6.7 The network between the board and the guest is one-directional 🟢

| Direction | Result |
|---|---|
| guest → board (`192.168.136.131` → `192.168.5.100`) | ✅ works ✓ |
| board → guest | ❌ `Network is unreachable` ✓ (not on the same segment ✓) |

> → `iperf3` must have the board as the server ✓ (the other way round does not work ✓).

#### 3.6.8 The measured speeds of the eMMC and the storage 🟢

| Measurement | Measured | Manual |
|---|---|---|
| eMMC write (`/userdata`, 50 MB, `conv=fdatasync`) | 253 MB/s ✓ | 164 MB/s ✓ |
| eMMC read (`hdparm -t /dev/mmcblk0p8`) | 345 MB/s ✓ | 320 MB/s ✓ |
| Gigabit Ethernet (iperf3, the board as the server) | 421–425 Mbits/sec ✓ | ~900 Mbits/sec (direct connection comparison ✓) |

> ⚠️ The write benchmark must use `conv=fdatasync` ✓ — without it what is measured is the speed into the cache ✗.

#### 3.6.9 Two self-destructive command traps 🟢

| Trap | Symptom | Correct way |
|---|---|---|
| `pkill -f "iperf3 -s"` | it kills its own shell as well ✓ (`-f` matches the whole command line ✓, and the pattern appears in its own command line ✓) → the command produces no output at all ✓ and a non-zero exit code ✓ | `pkill -x iperf3` ✓ (matches the process name only ✓) |
| the statistics of `dd` go to stderr | the output slot is empty ✓ (the executor only takes stdout ✓) | the command adds `2>&1` itself ✓ |

#### 3.6.10 Two more 🟢

| Fact | Value |
|---|---|
| `/proc/device-tree/model` | it carries a trailing NUL ✓ → pasting it into a command is rejected by the injection guard ✓ (`tr -d '\0'` when the value is read ✓) |
| Serial node | only `/dev/ttyS3` ✓ (UART2 is the debug console ✓, it has no node ✓) |
| Sound cards | `0 rockchiphdmiin` · `1 rockchipes8388` ✓ · `2 rockchiphdmi0` · `3 rockchiphdmi1` ✓ |
| → | the vendor's `mic_test.sh` uses `amixer -c 3` ✓ → that points at hdmi1 ✗ → the name `rockchipes8388` has to be used ✓ |

---

## 6. The re-check commands (run on the host)

```powershell
$adb = "C:\Users\<user>\Downloads\platform-tools_r33.0.3-windows\platform-tools\adb.exe"

& $adb devices -l                                   # is the board in the device state
& $adb -s 0000000000000000 shell 'cat /etc/os-release | head -2; uname -r'
& $adb -s 0000000000000000 shell 'grep MemTotal /proc/meminfo'
& $adb -s 0000000000000000 shell 'cat /sys/class/devfreq/fb000000.gpu/load'
& $adb -s 0000000000000000 shell 'cat /sys/kernel/debug/rknpu/load'
& $adb -s 0000000000000000 shell 'grep CPU part /proc/cpuinfo'
& $adb -s 0000000000000000 shell 'grep debugfs /proc/mounts'
& $adb -s 0000000000000000 shell 'cat /sys/class/thermal/thermal_zone5/type'
```

> Note: in PowerShell `2>/dev/null` is swallowed by PowerShell itself (it treats it as a redirection).
> A board-side command has to go into single quotes as a whole before it is passed, or use `shell sh -c '...'`.