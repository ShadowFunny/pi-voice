import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, { type VoiceDeps } from "../index.ts";
import { DEFAULT_CONFIG, type VoiceConfig } from "../src/config.ts";
import { describeProblems } from "../index.ts";
import { environmentReady, type EnvironmentReport, type PythonProbe, type Problem } from "../src/environment.ts";
import { TranscribeError } from "../src/transcriber.ts";

interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** The raw terminal key listener that `ctx.ui.onTerminalInput` installs. */
type TerminalKeyHandler = (data: string) => { consume?: boolean } | undefined;

/** A diagnosis of a machine where everything is in place. */
const READY_PROBE: PythonProbe = {
	command: ["python3"], version: "3.13.2", supported: true,
	hasFasterWhisper: true, fasterWhisperVersion: "1.2.1", hasPip: true, detail: "",
};

const READY_REPORT: EnvironmentReport = {
	ready: true, probe: READY_PROBE, candidatesTried: ["python3"], probeNotes: [], problems: [],
};

/** A probe for an interpreter that is fine but has no faster-whisper. */
const PROBE_WITHOUT_FW: PythonProbe = {
	...READY_PROBE, hasFasterWhisper: false, fasterWhisperVersion: null,
};

/**
 * Uses the production readiness rule rather than restating it, so a fixture cannot claim an
 * environment is unusable when `environmentReady` would accept it — an uncached model, for
 * instance, is a download and not a blocker.
 */
function reportWith(probe: PythonProbe | null, problems: Problem[]): EnvironmentReport {
	return { ready: environmentReady(problems), probe, candidatesTried: ["python3"], probeNotes: [], problems };
}

/** A stand-in recording, so the gate and the transcription path can run without hardware. */
function fakeHandle(pcmPath: string) {
	return {
		pcmPath,
		get elapsedMs() { return 0; },
		ended: new Promise<void>(() => {}),
		stop: async () => ({ pcmPath, startedAt: Date.now() }),
		abort: async () => {},
	};
}

/**
 * Drives the extension exactly as pi does — by calling the exported factory — so
 * the registration contract, the subcommand dispatch, and the dependency gate are testable
 * without a TUI, a microphone, or a Python install.
 */
function harness(overrides: Partial<VoiceDeps> = {}) {
	const commands = new Map<string, RegisteredCommand>();
	const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	const pasted: string[] = [];
	const keyHandlers = new Set<TerminalKeyHandler>();

	const api = {
		registerCommand: (name: string, options: RegisteredCommand) => commands.set(name, options),
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => events.set(event, handler),
	};

	const ui = {
		notify: (message: string, level = "info") => { notifications.push({ message, level }); },
		setStatus: (_key: string, value?: string) => { statuses.push(value); },
		pasteToEditor: (text: string) => { pasted.push(text); },
		onTerminalInput: (handler: TerminalKeyHandler) => {
			keyHandlers.add(handler);
			return () => { keyHandlers.delete(handler); };
		},
		select: async () => undefined,
	};

	const ctx = { hasUI: true, mode: "tui", ui };

	(factory as unknown as (pi: unknown, deps: Partial<VoiceDeps>) => void)(api, {
		// The real classifier is imported from pi-tui, which only exists inside pi. Tests press
		// key names directly instead.
		matchesKey: (data: string, key: string) => data === key,
		...overrides,
	});

	/** Fire session_start, which is where the key handling is installed. */
	const start = async () => {
		const handler = events.get("session_start");
		if (handler) await handler({}, ctx);
	};

	/** Feed one keystroke to every registered listener; true means the editor never saw it. */
	const press = (data: string): boolean => {
		let consumed = false;
		for (const handler of [...keyHandlers]) {
			if (handler(data)?.consume) consumed = true;
		}
		return consumed;
	};

	/** Let the work a keypress kicked off finish before asserting on it. */
	const settle = async () => {
		for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
	};

	/** Run the shutdown handler so no interval is left holding the test process open. */
	const dispose = async () => {
		const handler = events.get("session_shutdown");
		if (handler) await handler({}, ctx);
	};

	return { commands, events, notifications, statuses, pasted, ctx, start, press, settle, dispose };
}

function command() {
	const { commands } = harness();
	const found = commands.get("voice");
	assert.ok(found, "expected a voice command");
	return found;
}

test("registers the voice command", () => {
	const { commands } = harness();
	assert.ok(commands.has("voice"), "expected a voice command");
	assert.equal(commands.size, 1, "should register exactly one command");
	assert.match(commands.get("voice")!.description ?? "", /transcribe/i);
});

test("subscribes to session_shutdown so a live recording is not orphaned", () => {
	const { events } = harness();
	assert.ok(events.has("session_shutdown"), "expected a session_shutdown handler");
});

test("argument completions cover every subcommand and filter by prefix", () => {
	const all = command().getArgumentCompletions?.("") as Array<{ value: string }>;
	assert.deepEqual(all.map((c) => c.value).sort(), ["cancel", "config", "devices", "doctor", "setup", "status"]);

	const filtered = command().getArgumentCompletions?.("c") as Array<{ value: string }>;
	assert.deepEqual(filtered.map((c) => c.value).sort(), ["cancel", "config"]);

	// A prefix matching nothing must fall through rather than returning an empty list.
	assert.equal(command().getArgumentCompletions?.("zzz"), null);
});

test("status reports the idle state without throwing", async () => {
	const { notifications, ctx } = harness();
	await command().handler("status", ctx);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0].message, /idle/);
	assert.match(notifications[0].message, /base/);
});

test("config reports the effective configuration as JSON", async () => {
	const { notifications, ctx } = harness();
	await command().handler("config", ctx);
	const parsed = JSON.parse(notifications[0].message) as VoiceConfig;
	assert.deepEqual(Object.keys(parsed).sort(), Object.keys(DEFAULT_CONFIG).sort());
});

test("an unknown subcommand is reported instead of silently recording", async () => {
	const { notifications, ctx } = harness();
	await command().handler("wibble", ctx);
	assert.equal(notifications[0].level, "error");
	assert.match(notifications[0].message, /wibble/);
});

test("cancel with nothing recording says so instead of erroring", async () => {
	const { notifications, ctx } = harness();
	await command().handler("cancel", ctx);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0].message, /Nothing to cancel/);
	assert.equal(notifications[0].level, "info");
});

// --- environment gating and the doctor/setup copy ---

test("describeProblems recommends /voice setup first when setup can fix it", () => {
	const problems: Problem[] = [{
		kind: "no_faster_whisper",
		summary: "faster-whisper is not installed for python3.",
		setupFixes: true,
		manualCommands: [],
	}];
	const text = describeProblems(problems, "darwin");
	const setupAt = text.indexOf("/voice setup");
	const manualAt = text.indexOf("pip3 install faster-whisper");
	assert.ok(setupAt >= 0, "should recommend setup");
	assert.ok(manualAt >= 0, "should still show the manual command");
	assert.ok(setupAt < manualAt, "setup must come first");
});

test("describeProblems does not offer setup for a missing interpreter", () => {
	const problems: Problem[] = [{
		kind: "no_python",
		summary: "No Python interpreter was found.",
		setupFixes: false,
		manualCommands: [],
	}];
	const text = describeProblems(problems, "darwin");
	assert.ok(!text.includes("/voice setup"), "setup cannot install Python, so it must not be offered");
	assert.match(text, /brew install python|command line tools/);
});

test("describeProblems returns empty text when there is nothing wrong", () => {
	assert.equal(describeProblems([], "darwin"), "");
});

test("describeProblems includes every problem, not just the first", () => {
	const problems: Problem[] = [
		{ kind: "no_faster_whisper", summary: "missing faster-whisper", setupFixes: true, manualCommands: [] },
		{ kind: "model_not_cached", summary: "model base is not cached", setupFixes: false, manualCommands: [] },
	];
	const text = describeProblems(problems, "darwin");
	assert.match(text, /missing faster-whisper/);
	assert.match(text, /not cached/);
});

// ---------------------------------------------------------------------------
// The dependency gate: /voice must not touch the microphone when the
// environment cannot transcribe, and /voice setup is the documented remedy.
// ---------------------------------------------------------------------------

const MISSING_FW: Problem = {
	kind: "no_faster_whisper",
	summary: "faster-whisper is not installed for python3 (3.13.2).",
	setupFixes: true,
	manualCommands: [],
};

test("refuses to record when the environment is not ready", async () => {
	let started = false;
	const { commands, notifications, ctx } = harness({
		runDiagnosis: async () => reportWith(PROBE_WITHOUT_FW, [MISSING_FW]),
		startRecording: async () => {
			started = true;
			throw new Error("the microphone must not be touched");
		},
	});

	await commands.get("voice")!.handler("", ctx);

	assert.equal(started, false, "a broken environment must not produce an untranscribable recording");
	const last = notifications.at(-1)!;
	assert.equal(last.level, "error");
	assert.match(last.message, /faster-whisper is not installed/);
	assert.match(last.message, /\/voice setup/, "the remedy must be the setup subcommand");
});

test("records when the environment is ready", async () => {
	let started = false;
	const dir = mkdtempSync(join(tmpdir(), "pvfw-idx-"));
	try {
		const h = harness({
			runDiagnosis: async () => READY_REPORT,
			startRecording: async () => {
				started = true;
				return fakeHandle(join(dir, "x.pcm"));
			},
		});
		await h.commands.get("voice")!.handler("", h.ctx);
		assert.equal(started, true);
		assert.match(h.statuses.at(-1) ?? "", /recording/);
		await h.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the diagnosis is cached, so probing does not repeat per dictation", async () => {
	let calls = 0;
	const dir = mkdtempSync(join(tmpdir(), "pvfw-idx-"));
	try {
		const h = harness({
			runDiagnosis: async () => { calls++; return READY_REPORT; },
			startRecording: async () => fakeHandle(join(dir, "x.pcm")),
		});
		await h.commands.get("voice")!.handler("", h.ctx);
		await h.commands.get("voice")!.handler("status", h.ctx);
		await h.commands.get("voice")!.handler("config", h.ctx);
		assert.equal(calls, 1, "spawning interpreters on every subcommand would be wasteful");
		await h.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("doctor forces a fresh diagnosis and reports what it found", async () => {
	let calls = 0;
	const { commands, notifications, ctx } = harness({
		runDiagnosis: async () => {
			calls++;
			return {
				ready: true,
				probe: READY_PROBE,
				candidatesTried: ["python3", "python3.12"],
				probeNotes: ["python3.12: timeout (no response within 60s)"],
				problems: [],
			};
		},
	});

	await commands.get("voice")!.handler("doctor", ctx);
	const text = notifications.at(-1)!.message;
	assert.match(text, /candidates tried: python3, python3\.12/);
	assert.match(text, /using: python3 \(3\.13\.2\)/);
	assert.match(text, /faster-whisper: yes \(1\.2\.1\)/);
	assert.match(text, /model cached: yes/);
	assert.match(text, /timeout/, "a candidate that could not be probed should be reported");
	assert.match(text, /Environment is ready/);

	// Doctor is the "I just fixed something by hand" command, so it must not reuse the cache.
	await commands.get("voice")!.handler("doctor", ctx);
	assert.equal(calls, 2);
});

test("doctor reports which Chinese script will be steered", async () => {
	const run = async (cfg: Partial<VoiceConfig>) => {
		const h = harness({
			loadConfig: () => ({ ...DEFAULT_CONFIG, ...cfg }),
			runDiagnosis: async () => READY_REPORT,
		});
		await h.commands.get("voice")!.handler("doctor", h.ctx);
		return h.notifications.at(-1)!.message;
	};

	// `auto` and plain zh mean Simplified; an explicit Traditional code means Traditional, so the
	// line has to follow the language rather than report the on/off flag alone.
	assert.match(await run({}), /chinese script: simplified/);
	assert.match(await run({ language: "zh-TW" }), /chinese script: traditional/);
	assert.match(await run({ simplifiedChinese: false }), /chinese script: off/);
	assert.match(await run({ language: "en" }), /chinese script: off/);
});

test("doctor reports the problems when the environment is not ready", async () => {
	const { commands, notifications, ctx } = harness({
		// The probe and the problems must agree: an interpreter can only be reported as
		// lacking faster-whisper if the probe actually says it lacks it.
		runDiagnosis: async () => reportWith(PROBE_WITHOUT_FW, [MISSING_FW]),
	});
	await commands.get("voice")!.handler("doctor", ctx);
	const last = notifications.at(-1)!;
	assert.equal(last.level, "error");
	assert.match(last.message, /faster-whisper: no/);
	assert.match(last.message, /\/voice setup/);
});

// ---------------------------------------------------------------------------
// /voice setup wiring
// ---------------------------------------------------------------------------

test("setup saves the venv interpreter, shows progress, and reports success", async () => {
	const saved: Array<Partial<VoiceConfig>> = [];
	const { commands, notifications, statuses, ctx } = harness({
		venvDir: () => "/tmp/fake-venv",
		saveConfig: (patch) => {
			saved.push(patch);
			return { ...DEFAULT_CONFIG, ...patch };
		},
		// Drives onProgress, because a real install reports each stage and turning those into
		// status updates is this handler's job.
		runSetup: async (options) => {
			options.onProgress("probe", "Looking for a Python interpreter…");
			options.onProgress("venv", "Creating a virtual environment…");
			options.onProgress("install", "Installing faster-whisper…");
			return { ok: true, python: "/tmp/fake-venv/bin/python", detail: "1.2.1", commands: [] };
		},
	});

	await commands.get("voice")!.handler("setup", ctx);

	assert.deepEqual(saved, [{ python: "/tmp/fake-venv/bin/python" }], "the config must point at the venv");
	assert.ok(statuses.some((s) => s?.startsWith("◌")), "a multi-minute install must show progress");
	assert.equal(statuses.at(-1), undefined, "the status must be cleared when setup ends");
	assert.match(notifications.at(-1)!.message, /Installed faster-whisper 1\.2\.1/);
	assert.match(notifications.at(-1)!.message, /first dictation will download the speech model/);
});

test("a successful setup invalidates the cached diagnosis", async () => {
	let diagnoses = 0;
	const { commands, ctx } = harness({
		venvDir: () => "/tmp/fake-venv",
		saveConfig: () => DEFAULT_CONFIG,
		runDiagnosis: async () => { diagnoses++; return READY_REPORT; },
		runSetup: async () => ({ ok: true, python: "/tmp/v/bin/python", detail: "1.2.1", commands: [] }),
	});

	await commands.get("voice")!.handler("doctor", ctx);   // populate the cache
	assert.equal(diagnoses, 1);
	await commands.get("voice")!.handler("setup", ctx);    // invalidates it
	await commands.get("voice")!.handler("doctor", ctx);
	assert.equal(diagnoses, 2, "setup changes the interpreter, so the old verdict is stale");
});

test("a failed setup reports the detail and leaves the config alone", async () => {
	let saved = 0;
	const { commands, notifications, statuses, ctx } = harness({
		venvDir: () => "/tmp/fake-venv",
		saveConfig: () => { saved++; return DEFAULT_CONFIG; },
		runSetup: async () => ({
			ok: false, reason: "install_failed", python: "",
			detail: "ERROR: No matching distribution found",
			commands: ["/v/bin/python -m pip install faster-whisper"],
		}),
	});

	await commands.get("voice")!.handler("setup", ctx);

	assert.equal(saved, 0, "a broken venv must not be written into the config");
	assert.equal(statuses.at(-1), undefined, "progress must be cleared even on failure");
	const last = notifications.at(-1)!;
	assert.equal(last.level, "error");
	assert.match(last.message, /No matching distribution/);
	assert.match(last.message, /pip install faster-whisper/, "the suggested command should come through");
});

test("setup refuses to run while a recording is in progress", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pvfw-idx-"));
	try {
		let setupCalled = false;
		const h = harness({
			runDiagnosis: async () => READY_REPORT,
			startRecording: async () => fakeHandle(join(dir, "x.pcm")),
			venvDir: () => "/tmp/fake-venv",
			runSetup: async () => {
				setupCalled = true;
				return { ok: true, python: "/tmp/v/bin/python", detail: "1.2.1", commands: [] };
			},
		});

		await h.commands.get("voice")!.handler("", h.ctx);      // start recording
		await h.commands.get("voice")!.handler("setup", h.ctx); // must refuse

		assert.equal(setupCalled, false);
		assert.match(h.notifications.at(-1)!.message, /Stop the recording first/);
		await h.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("setup reports the venv location it is about to populate", async () => {
	const { commands, notifications, ctx } = harness({
		venvDir: () => "/custom/data/pi-voice/venv",
		runSetup: async () => ({ ok: true, python: "/custom/data/pi-voice/venv/bin/python", detail: "1.2.1", commands: [] }),
		saveConfig: () => DEFAULT_CONFIG,
	});
	await commands.get("voice")!.handler("setup", ctx);
	assert.match(notifications[0].message, /\/custom\/data\/pi-voice\/venv/);
	assert.match(notifications[0].message, /few hundred MB/);
});

// ---------------------------------------------------------------------------
// Transcription wiring
// ---------------------------------------------------------------------------

test("transcription uses the interpreter the diagnosis verified", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pvfw-idx-"));
	try {
		// A real file, because stopDictation stats it to enforce the minimum length.
		const pcm = join(dir, "rec.pcm");
		writeFileSync(pcm, Buffer.alloc(16000 * 2));

		let usedPython = "";
		const h = harness({
			loadConfig: () => ({ ...DEFAULT_CONFIG, python: "python3" }),
			runDiagnosis: async () => ({
				...READY_REPORT,
				probe: { ...READY_PROBE, command: ["python3.13"] },
			}),
			startRecording: async () => fakeHandle(pcm),
			transcribe: async (_pcm, cfg) => {
				usedPython = cfg.python;
				return { text: "hello", language: "en", languageProbability: 1, durationSeconds: 2, elapsedSeconds: 1, segments: [] };
			},
		});

		await h.commands.get("voice")!.handler("", h.ctx);  // start
		await h.commands.get("voice")!.handler("", h.ctx);  // stop -> transcribe

		// Otherwise the doctor can vouch for python3.13 while transcribe spawns python3.
		assert.equal(usedPython, "python3.13");
		assert.deepEqual(h.pasted, ["hello"], "the transcript goes to the editor, unsent");
		assert.match(h.statuses.at(-1) ?? "", /inserted/);
		await h.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("says so when the model will be downloaded on the first run", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pvfw-idx-"));
	try {
		const pcm = join(dir, "rec.pcm");
		writeFileSync(pcm, Buffer.alloc(16000 * 2));

		const h = harness({
			runDiagnosis: async () => reportWith(READY_PROBE, [{
				kind: "model_not_cached", summary: "Model \"base\" is not cached", setupFixes: false, manualCommands: [],
			}]),
			startRecording: async () => fakeHandle(pcm),
			transcribe: async () => ({ text: "hi", language: "en", languageProbability: 1, durationSeconds: 2, elapsedSeconds: 1, segments: [] }),
		});

		await h.commands.get("voice")!.handler("", h.ctx);
		await h.commands.get("voice")!.handler("", h.ctx);

		assert.ok(
			h.statuses.some((s) => s?.includes("first run downloads the model")),
			`expected the download hint, got ${JSON.stringify(h.statuses)}`,
		);
		await h.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an empty transcription reports hearing nothing instead of pasting blanks", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pvfw-idx-"));
	try {
		const pcm = join(dir, "rec.pcm");
		writeFileSync(pcm, Buffer.alloc(16000 * 2));

		const h = harness({
			runDiagnosis: async () => READY_REPORT,
			startRecording: async () => fakeHandle(pcm),
			transcribe: async () => ({ text: "   ", language: "en", languageProbability: 1, durationSeconds: 2, elapsedSeconds: 1, segments: [] }),
		});

		await h.commands.get("voice")!.handler("", h.ctx);
		await h.commands.get("voice")!.handler("", h.ctx);

		assert.deepEqual(h.pasted, [], "nothing should be pasted");
		assert.match(h.notifications.at(-1)!.message, /Heard nothing/);
		await h.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// The recording key bindings. pi hands the editor a raw key stream, and these
// listeners sit in front of it: only Enter and Escape are ever taken away.
// ---------------------------------------------------------------------------

/** A recording over a real file, because stopping stats it to enforce a minimum length. */
function recordingHarness(overrides: Partial<VoiceDeps> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pvfw-keys-"));
	const pcm = join(dir, "rec.pcm");
	writeFileSync(pcm, Buffer.alloc(16000 * 2));
	const h = harness({
		runDiagnosis: async () => READY_REPORT,
		startRecording: async () => fakeHandle(pcm),
		...overrides,
	});
	// Disposing first matters: every recording leaves a status interval running, and a failed
	// assertion would otherwise keep the test process alive forever.
	const cleanup = async () => {
		await h.dispose();
		rmSync(dir, { recursive: true, force: true });
	};
	return { ...h, pcm, cleanup };
}

test("Enter finishes the recording and transcribes it", async () => {
	const h = recordingHarness({
		transcribe: async () => ({
			text: "你好", language: "zh", languageProbability: 1, durationSeconds: 2,
			elapsedSeconds: 1, scriptSteering: "simplified", segments: [],
		}),
	});
	try {
		await h.start();
		await h.commands.get("voice")!.handler("", h.ctx);

		assert.equal(h.press("enter"), true, "Enter belongs to the recording, not the editor");
		await h.settle();

		assert.deepEqual(h.pasted, ["你好"], "the transcript goes to the editor, unsent");
	} finally {
		await h.cleanup();
	}
});

test("Escape discards the recording instead of transcribing it", async () => {
	let transcribed = false;
	const h = recordingHarness({
		transcribe: async () => {
			transcribed = true;
			return { text: "x", language: "en", languageProbability: 1, durationSeconds: 2, elapsedSeconds: 1, scriptSteering: null, segments: [] };
		},
	});
	try {
		await h.start();
		await h.commands.get("voice")!.handler("", h.ctx);

		assert.equal(h.press("escape"), true);
		await h.settle();

		assert.equal(transcribed, false, "a discarded recording must not be sent to the model");
		assert.match(h.notifications.at(-1)!.message, /Recording discarded/);
		assert.deepEqual(h.pasted, []);
	} finally {
		await h.cleanup();
	}
});

test("every other key still reaches the editor, and idle keeps Enter and Escape", async () => {
	const h = recordingHarness();
	try {
		await h.start();

		// Idle first: the extension must not stand between the user and pi's own bindings.
		assert.equal(h.press("enter"), false, "Enter must still submit when nothing is recording");
		assert.equal(h.press("escape"), false);

		await h.commands.get("voice")!.handler("", h.ctx);
		assert.equal(h.press("a"), false, "typing must keep working while recording");
		assert.equal(h.press("space"), false);
	} finally {
		await h.cleanup();
	}
});

test("Escape stops a transcription instead of waiting for it", async () => {
	let signal: AbortSignal | undefined;
	const h = recordingHarness({
		// Never resolves on its own: only the abort ends it, exactly like a real run.
		transcribe: (_pcm, _cfg, options) => new Promise((_resolve, reject) => {
			signal = options?.signal;
			options?.signal?.addEventListener("abort", () => {
				reject(new TranscribeError("cancelled", "stopped before it finished"));
			});
		}),
	});
	try {
		await h.start();
		await h.commands.get("voice")!.handler("", h.ctx);  // start
		assert.equal(h.press("enter"), true);                // finish -> transcribing
		await h.settle();
		assert.ok(signal, "transcription must be cancellable");
		assert.equal(signal.aborted, false);

		assert.equal(h.press("escape"), true);
		await h.settle();

		assert.equal(signal.aborted, true, "Escape must abort the transcriber process");
		assert.match(h.notifications.at(-1)!.message, /Transcription stopped/);
		assert.equal(existsSync(h.pcm), false, "a stopped transcription discards its audio");
		assert.deepEqual(h.pasted, []);

		// Back to idle: the next Enter is pi's again.
		assert.equal(h.press("enter"), false);
	} finally {
		await h.cleanup();
	}
});

test("Enter while transcribing warns instead of submitting a stale prompt", async () => {
	const h = recordingHarness({
		transcribe: () => new Promise(() => {}),
	});
	try {
		await h.start();
		await h.commands.get("voice")!.handler("", h.ctx);
		assert.equal(h.press("enter"), true);
		await h.settle();

		assert.equal(h.press("enter"), true, "the transcript is still coming, so Enter cannot submit");
		assert.match(h.notifications.at(-1)!.message, /Still transcribing/);

		// Leave the session through the normal exit path rather than a dangling promise.
		h.press("escape");
		await h.settle();
	} finally {
		await h.cleanup();
	}
});

test("a transcription that was stopped is not reported as a failure", async () => {
	const h = recordingHarness({
		transcribe: () => new Promise((_resolve, reject) => {
			setTimeout(() => reject(new TranscribeError("cancelled", "stopped before it finished")), 0);
		}),
	});
	try {
		await h.start();
		await h.commands.get("voice")!.handler("", h.ctx);
		await h.commands.get("voice")!.handler("", h.ctx);
		await h.settle();

		const last = h.notifications.at(-1)!;
		assert.equal(last.level, "info", "stopping on purpose is not an error");
		assert.match(last.message, /Transcription stopped/);
		assert.doesNotMatch(last.message, /failed/i);
	} finally {
		await h.cleanup();
	}
});
