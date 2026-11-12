# Architecture

## The one rule

The user interface never talks to a device directly. Everything goes through
`Target`, and that is what makes another board a configuration change rather
than a rewrite.

```
 +---------------------------------------------------------------+
 |  title bar: target switcher, monitor switch                    |
 +--------+------------------------------------------------------+
 |  rail  |  workspace stack                                      |
 |        |    +-----------------+   +---------------------+     |
 |        |    |  session tabs   |   |   file browser      |     |
 |        |    |  TerminalView   |   |   (lazy tree)       |     |
 |        |    +-----------------+   +---------------------+     |
 +--------+------------------------------------------------------+
 |  resource strip: CPU | GPU | NPU | memory                     |
 +---------------------------------------------------------------+
 |  status bar                                                     |
 +---------------------------------------------------------------+

       SessionTab            RemoteBrowser          ResourceStrip
             |                     |                      |
             +---------+-----------+                      |
                       |                                  |
              +--------v---------+          +-------------v-----------+
              |      Target     |          |    MetricsCollector       |
              |  (abstract API) |          |  (reads /proc, devfreq)   |
              +--------+---------+          +---------------------------+
                       |
      +---------+---------+----------+
      |         |         |          |
  AdbTarget SerialTarget SshTarget LocalTarget
      |         |         |
   adb.exe   pyserial  paramiko
```

## Modules

| Module | Responsibility |
|---|---|
| `core/targets.py` | The `Target` interface, `TargetProfile`, `FileEntry`, `TransportKind` |
| `core/registry.py` | Maps a transport name to its class; the extension seam |
| `core/adb_target.py` | ADB: one-shot commands, an interactive shell, pull/push |
| `core/serial_target.py` | UART console with marker-delimited command output |
| `core/ssh_target.py` | SSH shell, command execution and SFTP |
| `core/local_target.py` | The host machine; also the reference implementation |
| `core/metrics.py` | CPU / GPU / NPU / memory / temperature collection |
| `core/profiles.py` | Loads built-in and user-supplied target profiles |
| `core/local_target.py` | The host machine, as a target |
| `core/profiles.py` | Loads built-in and user-supplied target profiles |
| `core/session_log.py` | Timestamped session transcripts on the local disk |
| `ui/main_window.py` | Window layout, session tabs, workspaces, resource strip |
| `ui/terminal_view.py` | Terminal rendering in pty and pipe modes, with colour |
| `ui/file_browser.py` | The lazy-loading file browser for a target |
| `ui/resource_strip.py` | The resource strip and its sampling thread |
| `ui/theme.py` | Colours, type scale and the application stylesheet |

## Two terminal modes

The transports are not alike, and pretending they are produces a terminal
that lags or garbles.

**Pipe mode** (`adb shell` without a PTY). The remote side sends no prompt
and no echo, and on Windows the reply arrives immediately. The widget draws
the prompt and echoes the command itself.

**PTY mode** (`ssh`, `adb shell -t`). The remote side provides a real
terminal with ANSI colour and echo. Output is fed through `pyte` and drawn
as a screen.

The choice matters more than it looks. With `adb shell -t -t` on Windows the
reply is batched until the *next* command is sent, so output appears one
command late. That is why the ADB transport deliberately avoids a PTY.

## The renderer draws cells

A terminal is a grid of cells, each with its own colour, plus a cursor
that can sit anywhere in it. A text widget models a stream of characters,
so everything a terminal does -- the columns of a listing lining up, a
cursor in the middle of a line, a selection across cell boundaries --
has to be patched on afterwards.

So the screen is drawn directly, cell by cell, and the layers are kept
apart the way xterm.js keeps them apart:

| Layer | Who does it |
|---|---|
| VT parser | pyte |
| Buffer: cells, scrollback, cursor | pyte |
| Viewport: where the view is looking | :mod:`devboard_console.ui.cell_renderer` |
| Renderer: cells to pixels | :mod:`devboard_console.ui.cell_renderer` |
| Input | :mod:`devboard_console.ui.keymap` and :mod:`devboard_console.ui.line_editor` |

The viewport being separate from the buffer is what makes scrolling work:
moving the view does not move the text.

The emulated screen is as tall as the view, and the scrollback has its own
depth. A screen that was taller than the view would push the newest
output out of sight, because pyte does not reflow: narrowing the screen
really does drop the cells on the right, and widening it does not bring
them back.

## The parts of a terminal

The output side is a real terminal: pyte parses the escape sequences,
keeps the screen and the scrollback, and says where the cursor is.

The input side depends on who is doing the editing. A device that runs
a real terminal echoes the typing and edits the line itself, so the
console only forwards keystrokes and draws the cursor where the device
says it is. A pipe has no readline on the far side, so the console keeps
the line in a :class:`~ui.line_editor.LineEditor` -- a plain class with an
integer caret, a kill ring and a history -- and shows it in an input line
under the terminal.

The mapping between a key and what it means is in
:mod:`devboard_console.ui.keymap`, so it can be tested on its own.

## Two kinds of session

A target that runs a real terminal -- ``ssh``, or a serial console -- gives
the user a prompt, an echo and line editing. The console only forwards
keystrokes and draws the cursor where the device says it is.

A pipe -- ``adb shell`` without a PTY -- gives none of that, so the console
provides it: an input line under the terminal, with the prompt, a caret, the
usual editing keys and a command history.

## Colour

The board already produces colour; the console has to let it through.

`adb shell` sets `TERM=dumb`, and GNU coreutils -- the board's `ls` is
coreutils, not BusyBox -- refuses to colourise anything in that case,
even with `--color=always`. The ADB transport therefore sets
`TERM=xterm-256color` when the session opens.

A non-interactive shell does not expand aliases, so the usual
`alias ls='ls --color=auto'` would silently do nothing. The transport
installs shell *functions* instead:

```sh
export TERM=xterm-256color
ls() { command ls -C --color=always "$@"; }
```

`-C` makes `ls` lay the entries out in columns. A real terminal gets
that for free; a pipe does not. coreutils quietly falls back to one per
line when `-l` or `-1` is given, so the two never fight.

The prompt is drawn by the console rather than taken from the device,
because the board's own `PS1` is plain text. It uses the colours a
Linux shell would use.

## Threading

| Thread | Work |
|---|---|
| GUI thread | Widgets only |
| Child processes | Started with ``CREATE_NO_WINDOW``, so no console window flashes on the screen |
| Session worker | Reads the target's output stream and emits chunks |
| Metrics worker | Polls the collector once a second |
| Pool thread | Opening a connection, listing a directory, running a one-off command |

Everything that talks to a device can take seconds, so all of it runs
off the GUI thread and the result comes back through a signal. The
workers live on their own `QThread` and talk back through signals.

A thread that has not stopped by the time the window closes is kept
alive rather than dropped: destroying a `QThread` that is still running
aborts the process.

Nothing in `core/` imports Qt, so the transports and the parsers can be
tested without a display.

## Adding a transport

Implement `Target`, register it, and add a profile:

```python
from devboard_console.core.registry import register_transport
from devboard_console.core.targets import Target

class MyTransport(Target):
    def open(self): ...
    def close(self): ...
    def run(self, command, timeout=30.0): ...
    def stream(self): ...
    def send(self, data): ...
    def list_dir(self, path): ...
    def download(self, remote_path, local_path, progress=None): ...
    def upload(self, local_path, remote_path, progress=None): ...
    def capabilities(self):
        return frozenset({"shell", "exec", "stream"})

register_transport("my-transport", MyTransport)
```

The transport name is a plain string, so a profile may name a transport
that was registered after the program started:

```json
{ "id": "x", "label": "X", "transport": "my-transport" }
```

`capabilities()` decides what the interface shows. A transport without
`files` gets its file browser disabled, and one without `stream` gets no
live terminal.

`run()` must return 124 when a command times out, whatever the
transport underneath does, so the caller sees one meaning for it.

## How a session is presented

Two things decide how a session looks, and both belong to the profile
rather than to the code:

* `pty: true` -- the target runs a real terminal. It echoes the user and
  prints its own prompt, so the console only forwards keystrokes.
* `pty: false` -- the target is a pipe. It echoes nothing, so the console
  draws the prompt and the typing itself.

The console used to decide this from the transport *name*, which meant a
newly registered transport would be treated as a real terminal whether
it was one or not.
