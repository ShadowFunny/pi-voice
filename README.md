# pi-voice

Offline voice input for [pi](https://pi.dev), registered as **`/voice`**. Audio capture comes
from [PvRecorder](https://www.npmjs.com/package/@picovoice/pvrecorder-node), which ships its
own prebuilt binaries; transcription comes from a local
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) install.

**The only thing you install is `faster-whisper`.**

## Requirements

- **A microphone your terminal is allowed to use.** On macOS, grant it under
  System Settings → Privacy & Security → Microphone.

- **Python 3.9+ with `faster-whisper`.** If you do not have it, you do not need to work out
  how to install it: run **`/voice setup`** and it will report what is missing, or create a
  virtual environment and install `faster-whisper` into it for you. `/voice doctor` shows
  what was found and what is wrong at any time.

  To do it yourself instead:

  ```bash
  pip3 install faster-whisper          # macOS / Linux
  py -3 -m pip install faster-whisper  # Windows
  ```

- **One `npm install`** in the project directory, to fetch the bundled recorder binary.
  (If you install this as a pi package, pi does that for you.)

No `ffmpeg`, no `sox`, no Homebrew, no compiler. Transcription is fully offline; the only
network use is the one-time model download on the first run of a model that is not cached.

### What `/voice setup` does and does not do

It **does**: find a suitable Python, create a virtual environment at
`~/.local/share/pi-voice/venv` (outside this repository on purpose), `pip install
faster-whisper` into it, verify the import, and point the `python` config key at it. It is
idempotent, so re-running it is also the fix for a broken environment.

It **does not**: install Python itself — that needs `winget`, `brew`, a distribution
package manager, or an installer, usually with elevated privileges, so when no interpreter
exists it stops and prints the command for your platform. It also does not download the
speech model: the model size ranges from ~75 MB to ~1.5 GB depending on `model`, and you may
want to change that first. The first transcription downloads it, and the status line says so
when that is about to happen.

## Install

```bash
pi install npm:@shadowfunny/pi-voice
```

pi runs `npm install` for the package, which fetches the bundled recorder binary. Then run
`/reload`.

If a dependency is missing, `/voice doctor` reports it and `/voice setup` installs it — see
[Requirements](#requirements).

### If you already have another extension that provides `/voice`

If another installed extension registers the same `/voice` command, pi keeps both
registrations and suffixes them, so you get `/voice:1` and `/voice:2` instead of a plain
`/voice`. Uninstall the other extension first if you do not need both:

```bash
pi list
pi remove <the-other-package>
```

### Installing from a checkout instead

For development, or to run a branch that is not published:

```bash
git clone https://github.com/ShadowFunny/pi-voice ~/src/pi-voice
cd ~/src/pi-voice && npm install
ln -s ~/src/pi-voice ~/.pi/agent/extensions/pi-voice
```

The symlink is what makes pi discover the extension. pi's loader follows symlinked
directories (`entry.isDirectory() || entry.isSymbolicLink()`), so `/reload` keeps working.
Pointing at the real directory through `settings.json` also works but is not hot-reloadable.

## Usage

| Command | Effect |
| --- | --- |
| `/voice` | Start recording. Run it again to stop, transcribe, and insert. |
| `/voice cancel` | Discard the recording in progress, or stop a transcription. |
| `/voice status` | Report the current state and active model. |
| `/voice devices` | List audio inputs with their indices. |
| `/voice config` | Print the effective configuration as JSON. |
| `/voice doctor` | Report the Python environment: what was found, what is missing, and how to fix it. |
| `/voice setup` | Create a virtual environment and install `faster-whisper` into it. |

`/voice` checks the environment once per session before it touches the microphone, so a
missing dependency is reported instead of producing a recording that cannot be transcribed.

The transcript is inserted at the cursor in the prompt editor. It is **not** sent — you
review it first.

While recording, the footer shows `● recording 0:07 — Enter to stop · Esc to cancel`, and
transcription shows `◌ transcribing… — Esc to stop`. When a transcript lands, the footer shows
`✓ inserted (1.7s)` for two seconds.

### Ending a recording

| Key | While recording | While transcribing |
| --- | --- | --- |
| **Enter** | Stop, transcribe, and insert into the editor. | Nothing yet — the footer says so, because submitting now would send the prompt without the transcript. |
| **Esc** | Discard the recording without transcribing it. | Kill the transcriber process immediately and discard the audio. |
| Any other key | Typing and editing continue normally. | |

Recording almost never needs the keyboard, though: a recording that reaches `maxSeconds`
stops and transcribes on its own.

Enter and Esc are only taken away while a recording or a transcription is in flight. Idle,
they are pi's own submit and interrupt keys, and `/voice` stops a recording whenever the keys
are not available — in RPC mode, or if the editor integration cannot be installed.

## Configuration

`${XDG_CONFIG_HOME:-$HOME/.config}/pi-voice/config.json`, written with mode `0600`:

```json
{
	"model": "base",
	"language": "auto",
	"device": null,
	"python": "python3",
	"computeType": "int8",
	"cpuThreads": 4,
	"beamSize": 1,
	"vad": true,
	"maxSeconds": 120,
	"sampleRate": 16000,
	"initialPrompt": "",
	"simplifiedChinese": true
}
```

| Key | Notes                                                                                                                      |
| --- |----------------------------------------------------------------------------------------------------------------------------|
| `model` | `tiny` / `base` / `small` / `medium` / `large-v3`, or a local path.                                                        |
| `language` | `auto` detects per utterance. Otherwise a Whisper language code — see [Language codes](#language-codes). Not a BCP 47 tag. |
| `device` | `null` auto-selects the built-in microphone. Set an index from `/voice devices` to override.                               |
| `python` | The interpreter used for the transcriber. Point this at a venv if `faster-whisper` is not in the default environment.      |
| `maxSeconds` | Hard cap. A recording that reaches it is transcribed automatically.                                                        |
| `vad` | Silero voice-activity filter. Leave on: it trims silence and stops Whisper hallucinating text on quiet audio.              |
| `initialPrompt` | Bias the model with domain vocabulary.                                                  |
| `simplifiedChinese` | Steer Chinese output to a script rather than leaving it to Whisper. On by default — see [Chinese script](#chinese-script). |

A malformed config file is ignored field by field rather than fatally, so one bad value
cannot break dictation.

### Language codes

`language` takes either the literal `auto` — this extension's own sentinel, not a Whisper
value — or a code from Whisper's built-in language list. That list is **not** BCP 47, and it
is stricter than the OpenAI Whisper CLI used to be.

The 100 accepted codes are overwhelmingly **ISO 639-1 two-letter codes**, plus exactly two
three-letter ones, `haw` (Hawaiian) and `yue` (Cantonese):

```
af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha haw
he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my
ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt
uk ur uz vi yi yo yue zh
```

Accepted and rejected forms, verified against `faster-whisper` 1.2.1:

| Value | Accepted | Why |
| --- | --- | --- |
| `"zh"` | yes | ISO 639-1 |
| `"yue"` | yes | one of the two three-letter codes |
| `"auto"` | yes | handled by this extension, never passed to Whisper |
| `"zh-Hans"`, `"zh-CN"`, `"zh-Hant"`, `"zh-TW"` | yes | a Chinese script or region, translated to `zh` and used to pick the script — see [Chinese script](#chinese-script) |
| `"ZH"` | **no** | codes are lowercase |
| `"en-US"`, `"zh-Hans-CN"` | **no** | region and script subtags are not supported outside the Chinese codes above |
| `"zh_CN"` | **no** | underscore is not a separator Whisper knows |
| `"chinese"`, `"Chinese"` | **no** | full names are not accepted (older Whisper CLIs did) |

An invalid code is rejected by `faster-whisper` with
`ValueError: '<value>' is not a valid language code`, and because that happens in the
transcriber it surfaces **after** the recording has been made. Prefer `auto` if you are
unsure, and use `/voice doctor` to check the interpreter you are actually running.

### Chinese script

Whisper has no script subtag, and its Chinese output has no stable script either: the
committed Chinese fixture decodes to Traditional characters with nothing steering it, while
the same speaker elsewhere comes back Simplified. So the script is asked for through the
decoder prompt instead of through the language code:

| `language` | Chinese output |
| --- | --- |
| `auto` | Simplified, decided after the language is detected |
| `zh`, `zh-Hans`, `zh-CN`, `zh-SG` | Simplified |
| `zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO` | Traditional |
| anything else | Whatever Whisper produces |

One sentence in the wanted script is added to the decoder context when the audio is Chinese.
A script subtag is translated to `zh` for Whisper, which is the only form it accepts.

**It only ever applies to Chinese.** In `auto` mode the language is detected before decoding
with `detect_language()`, which is the same detection `transcribe()` runs internally anyway —
measured end to end, `1.49 s` steered against `1.84 s` unsteered on the same clip — and with
an explicit code no detection is needed at all. That matters because a Chinese prompt left on
globally is not harmless: measured on `base`, it left English, French, German, Japanese and
Korean byte-identical but turned Spanish audio into unrelated Chinese characters.

Your own `initialPrompt` is kept: the steering sentence is appended after it.

This is a bias, not a rewrite. It does not convert characters after the fact, so it cannot
mangle a proper noun, but it can still return a mixed-script transcript, the words are
untouched (Taiwanese wording stays Taiwanese), and a very short recording can be detected as
another language, in which case nothing is injected. Setting `"simplifiedChinese": false`
turns steering off in both directions and returns Whisper's own script. `/voice doctor`
reports whether it is on.

## Performance

Measured on a 4-core Intel i3-8100, cached `base` model at `int8`:

| Stage | Measurement |
| --- | --- |
| Recording start | **68 ms** |
| Capture accuracy | 2.53 s captured in 2.607 s wall — real time |
| Transcription | ~4 s fixed, then roughly 0.2–0.3× realtime |

Transcription latency is dominated by a **fixed ~4 s per invocation**, not by audio length.
Python startup, the numpy and ctranslate2 imports, and the model load all happen on every
dictation, and Whisper pads every input to a 30 s window, so even a one-word utterance pays a
full encoder pass. That means a one-word dictation and a thirty-second dictation feel broadly
the same.

If that floor becomes annoying, the fix is a resident Python worker that loads the model once
and reads PCM paths over a pipe, which would leave only the 0.2–0.3× realtime component. It
is deliberately not implemented: a single in-process measurement during design suggested the
load was 0.9 s, which did not justify the extra state machine. That measurement understated
per-invocation cost, and these numbers supersede it.

## Design notes

**Capture writes raw `s16le` PCM.** No WAV container, so no header to finalise and a
truncated recording is still valid audio. `faster-whisper` accepts a float32 numpy array, so
no container parsing is needed anywhere.

**Frames are written to disk as they arrive**, not assembled at the end. An interrupted
recording keeps everything captured up to that point.

**Audio capture used to shell out to `ffmpeg`.** That version worked but was macOS-only and
needed an `ffmpeg` install, and because ffmpeg buffers its output until exit, a failed start
was hard to distinguish from a working one and an ungraceful stop lost the entire recording.
Switching to PvRecorder deleted all of that: no subprocess, no start-detection window, no
stop signal, no external tool, and no platform-specific capture code.

**An unknown device index is an error, not a fallback.** Silently recording from a different
microphone than the one requested is worse than failing, because you cannot tell it happened.

**Only Enter and Escape are ever taken from the editor**, and only while a recording or a
transcription is in flight. A `registerShortcut` for Enter would have been worse than useless:
pi consumes any key an extension registers, so every prompt submission would have died with it.
Replacing the editor would have fought every other extension that customises one. A raw input
listener sits in front of the focused component instead, and returns nothing at all for any
other key.

**The transcript is inserted, never sent.** Dictation lands in the editor at the cursor so it
can be reviewed before it goes anywhere.

**Failures never blame permissions.** The message that motivated this project misattributed a
missing native library to a microphone permission problem. Every error here names the real
cause.

## Platform support, and how much of it is verified

| Platform | Status |
| --- | --- |
| macOS Intel (`x86_64`) | **Verified** — developed and tested here, including real microphone capture |
| macOS Apple Silicon (`arm64`) | Supported by the capture library; not exercised here |
| Windows (x64, arm64) | Supported by the capture library; not exercised here |
| Linux (x86_64, glibc) | Supported by the capture library; not exercised here |
| Linux musl (Alpine) | Untested; the capture library publishes no musl build |

"Supported by the capture library" means `@picovoice/pvrecorder-node` ships a prebuilt binary
for that target, and the platform-specific logic in this project — the interpreter candidate
list, the venv path layout, the `pip` argument spelling — is covered by unit tests that run on
all three operating systems in CI. What has **not** happened is an end-to-end run on a real
Windows or Linux machine, so treat those as expected to work rather than known to work.

CI runs the unit tests on Ubuntu, macOS and Windows across Node 22 and 24, and the
transcription tests against a real `faster-whisper` on Ubuntu. The microphone tests skip
themselves where there is no input device — which is every CI runner — so the recording path
is only ever verified on a machine with a real microphone.

## Layout

```
index.ts              pi wiring: /voice, subcommands, status, state machine
src/args.ts           transcriber argument builder (pure)
src/devices.ts        input selection (pure)
src/config.ts         config load/save/validate (pure merge)
src/environment.ts    python candidate probing, diagnosis, remediation copy
src/language.ts       language codes and Chinese script steering (pure)
src/setup.ts          virtualenv creation and the faster-whisper install
src/recorder.ts       PvRecorder capture: frame loop, teardown, maxSeconds cap
src/transcriber.ts    python process wrapper, failure mapping
python/transcribe.py  one-shot faster-whisper: raw PCM in, one JSON object out
tests/fixtures/        the committed 16 kHz PCM speech fixtures (en.pcm, zh.pcm)
.github/workflows/    CI: unit tests on 3 OSes, transcription on Ubuntu
```

## Tests

```bash
npm test                  # everything: 129 tests (~40s, plus ~60s when the setup test runs)
npm run test:unit         # no microphone, no Python
npm run test:transcribe   # needs a Python with faster-whisper

PVFW_SETUP_TEST=1 npm test   # also builds a real venv and pip-installs faster-whisper
```

The split exists because the halves need different things, and CI runs each on the machines
that can support it:

| CI job | Machines | Covers |
| --- | --- | --- |
| `unit` | ubuntu, macos, windows × node 22, 24 | pure logic, the command wiring, and the recorder (self-skipping) |
| `setup` | ubuntu, macos, windows | a real venv plus `pip install faster-whisper` |
| `transcribe` | ubuntu | the real transcriber over the committed fixtures |

No test framework, no bundler, and no build step — Node runs the TypeScript directly. Speech
fixtures are committed 16 kHz PCM and silence is generated in JS, so the suite needs neither
`say` nor `ffmpeg`.

Test files run **serially** (`--test-concurrency=1`), which is deliberate: `tests/recorder.test.ts`
captures real-time audio while the transcription tests run CPU-bound Whisper processes on all
four cores, and in parallel that oversubscription starves the capture.

### The two tests that are not always run

`tests/recorder.test.ts` drives real hardware. It **skips** where there is no input device, but
it **fails** if the recorder module cannot be loaded — a headless machine is not a defect, a
packaged extension that cannot load its recorder is. Running it briefly activates your input
device.

`tests/setup-run.test.ts` creates a real virtual environment and installs `faster-whisper`
(~200 MB). It is gated behind `PVFW_SETUP_TEST=1` so a routine `npm test` stays fast and works
offline, with the CI `setup` job running it on every push on all three platforms:

```bash
PVFW_SETUP_TEST=1 node --test tests/setup-run.test.ts
```

### What the wiring tests cover

The dependencies of `index.ts` are injectable (`VoiceDeps`), so the command handlers are tested
without a microphone, a Python install, or a download. `tests/index.test.ts` covers the
dependency gate — `/voice` must refuse to record rather than produce a recording it cannot
transcribe — plus `/voice setup` saving the venv interpreter, reporting progress, clearing its
status on failure, refusing to run mid-recording, and invalidating the cached diagnosis;
`/voice doctor` forcing a fresh probe; the uncached-model hint; and the rule that transcription
uses the interpreter the diagnosis verified.
