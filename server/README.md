# meet-live-assist-server

Local bridge server for the [Meet Live Assist](https://krystiangw.github.io/meet-live-assist/) browser
extension. The extension captures a Google Meet or Zoom call; this server is what it talks to, and what your
own assistant reads.

```bash
npx meet-live-assist-server
```

It prints an auth token on first run. Paste that into the extension's Options once and you are done.

## What it does

- **Transcript sink.** Every caption line is appended to `<data-dir>/<session>.txt`, the complete record.
- **Wake channel.** A second file, `<session>.wake`, gets only the batches worth waking an assistant for
  (decisions, blockers, your name, real questions). Tailing that instead of the raw transcript is what keeps
  a 40-minute call from costing hundreds of assistant turns.
- **Advice, board, chat.** The assistant posts colour-coded advice, decisions and action items; the panel
  polls them back.
- **Snapshots** of a shared screen, for visual context.
- **Local speech-to-text** through [whisper.cpp](https://github.com/ggerganov/whisper.cpp), fully offline,
  for calls with no captions.
- **Text-to-speech into the call** (macOS only, see below).

## Nothing leaves your machine

It binds `127.0.0.1` only, has no accounts and no telemetry, and writes to files you own. Every route except
`/health` and `/auth-check` requires the `X-MLA-Token` header, so a website you happen to be visiting cannot
reach it. Transcripts and snapshots are purged after `RETENTION_DAYS` (14 by default).

If your assistant uses a cloud model, whatever you route to it is subject to that provider's terms. That
part is your configuration, not this server.

## Requirements

**Node 20+** is the only hard requirement. Two optional binaries unlock the audio features:

| | install | without it |
| --- | --- | --- |
| `ffmpeg` | `brew install ffmpeg` / `apt install ffmpeg` | no local STT, no audio routing |
| `whisper-cli` + a ggml model in `~/.local/share/whisper/` | `brew install whisper-cpp` | no local STT (captions still work) |

**Text-to-speech is macOS-only.** It uses `say` and `afplay`. Everywhere else the server runs fine and
advice appears in the panel as text; only the spoken output is missing.

## Config

All optional, all env vars.

| var | default | what it does |
| --- | --- | --- |
| `PORT` | `8848` | the extension has host permission for `127.0.0.1:8848`; changing it needs a matching extension setting |
| `TRANSCRIPTS_DIR` | `~/meet-live-assist/transcripts` | data dir (transcripts, snapshots, `.mla-token`) |
| `RETENTION_DAYS` | `14` | purge transcripts and snapshots older than this (`0` keeps them forever) |
| `WAKE_BASE_MS` / `WAKE_MAX_MS` | `10000` / `90000` | wake-gate window: starts here, doubles on an empty batch up to the max |
| `WAKE_FORCE_MS` | `180000` | flush whatever is buffered after this long, gate or no gate |
| `WAKE_MIN_GAP_MS` | `8000` | floor between two wakes |
| `WHISPER_MODEL` | `~/.local/share/whisper/ggml-base.bin` | which ggml model to transcribe with |
| `WHISPER_PROMPT` | a generic technical word list | bias whisper toward your own product names and ticket prefixes |
| `FFMPEG` / `WHISPER_CLI` / `WHISPER_SERVER` | resolved from Homebrew, `/usr/local`, `/usr/bin`, then `PATH` | override a binary path |
| `TTS_VOICE` | `Zosia` | macOS voice for spoken advice |

## Health

```bash
curl -s http://127.0.0.1:8848/health
# {"ok":true,"dir":"...","tools":{"ffmpeg":true,"whisper":true,"whisperModel":"ggml-base.bin","blackhole":false}}
```

`tools` tells you which optional features are live, so a missing `ffmpeg` shows up here rather than as a
mystery later.
