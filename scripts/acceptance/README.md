# The acceptance tools (they drive the real application headless)

> **Why these scripts exist**: most of the criteria of the acceptance list are
> "click the button, look at the screen". A human clicking them can only
> verify once, and it cannot be repeated.
> **CDP (Chrome DevTools Protocol) can drive the real renderer from the
> outside** — read the DOM, click the buttons, type the keys, and the criteria
> become **a script that can be run again**.
>
> These scripts were used for the real acceptance on 2026-11-13.

## The five scripts

| File | What it does |
|---|---|
| `cdp.mjs` | a minimal CDP driver: it connects to the renderer of the local Electron and evaluates a JS expression (read the DOM, click the buttons) |
| `run-app.sh` | it starts the real Electron with **Xvfb** in a Linux sandbox that has no display, with `--remote-debugging-port` |
| `fake-console.py` | a "fake board": it plays the serial console at the other end of a pty (**echoes** every line + answers the marker), to verify the marker protocol of the serial port |
| `adb-forward.py` | it forwards the local `127.0.0.1:5037` to the **adb server of the host** — that lets the application in the sandbox reach the real board on the USB bus, **without changing one line of the application code** |
| `linux-natives.sh` | it puts the native modules of the shared `node_modules` back into the shape that works on Linux (**the two sides share one node_modules, the native modules are compiled per platform and they fight each other**) |

## How to use it

```bash
# the dependencies: the Linux binary of Electron, Xvfb, the GTK runtime (LD_LIBRARY_PATH)
bash scripts/acceptance/run-app.sh your-script.mjs
```

`run-app.sh` starts Xvfb + Electron and then runs your script; when the script
ends it cleans up.

## The prerequisites and the limits (**do not take it for a universal tool**)

- **It only works on a Linux sandbox**. On Windows `npm run dev` opens a window
  on its own, none of this is needed.
- The **Linux binary of Electron is not in the npm package** (the `postinstall`
  downloads it). If it was never downloaded, run
  `node node_modules/electron/install.js` (or use the
  `npmmirror.com/mirrors/electron/` mirror, which is much slower).
- `fake-console.py` accepts **both CR and LF as a line ending** — node-serialport
  puts the serial port into raw mode (`ICRNL` off), so the `\r` that the return
  key sends is **not** turned into `\n`.
- The two directions of `adb-forward.py` are **half closed on their own**
  (`shutdown`), one side may not close the whole socket when it ends —
  otherwise **the long-lived `adb shell` session is killed as well when the
  second command comes in** (that looks like a bug of the application, while it
  is the fault of the forwarder).

## The criterion for "the acceptance really passed"

**The driver script has to read a real state**, not "it did not throw, so it
passed".
That is how the bug of 2026-11-13 was caught, a bug that the review did not
see: the shell of the board is bash, and the session environment script
carried one CR too many →
`/bin/bash: line 3: $'\r': command not found`.
— Reading the code does not show it, only running it on the real machine does.
