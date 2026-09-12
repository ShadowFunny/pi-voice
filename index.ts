import { rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./src/config.ts";
import { effectiveConfig, remediation, runDiagnosis, type EnvironmentReport, type Problem } from "./src/environment.ts";
import { listDevices, startRecording, type ActiveRecording } from "./src/recorder.ts";
import { runSetup, venvDir } from "./src/setup.ts";
import { planLanguage } from "./src/language.ts";
import { describeFailure, transcribe, TranscribeError } from "./src/transcriber.ts";

/** Fewer samples than this is never worth sending to the model. */
const MIN_SECONDS = 0.2;
const STATUS_KEY = "pi-voice";
const CONFIRM_MS = 2000;

/** The recording keys. Everything else stays with the editor. */
const KEY_FINISH = "enter";
const KEY_DISCARD = "escape";

/**
 * Render environment problems as user-facing copy.
 *
 * Order is the whole point. When `/voice setup` can fix a problem it is the first line,
 * because that is the one command the user can run for themselves. The manual command follows
 * as the alternative for someone who would rather manage their own environment. When setup
 * cannot help — a missing or too-old interpreter, which needs an installer and usually
 * elevation — setup is not mentioned at all, so nobody is sent after a command that would
 * fail.
 */
export function describeProblems(problems: Problem[], platform: NodeJS.Platform): string {
	if (problems.length === 0) return "";

	const blocks: string[] = [];
	for (const problem of problems) {
		const commands = remediation(problem, platform);
		const lines = [problem.summary];

		if (problem.setupFixes && commands.length > 0) {
			lines.push("");
			lines.push("Run \"/voice setup\" to create a virtual environment and install it.");
			lines.push("Or install it into the interpreter you already use:");
		}
		for (const command of commands) lines.push(`  ${command}`);

		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n\n");
}

/**
 * Collaborators, injectable so the wiring in this file can be tested without a microphone, a
 * Python install, or a 200 MB download.
 *
 * pi calls the factory with a single argument, so production always gets the real
 * implementations; tests pass overrides.
 */
export interface VoiceDeps {
	loadConfig: typeof loadConfig;
	saveConfig: typeof saveConfig;
	runDiagnosis: typeof runDiagnosis;
	runSetup: typeof runSetup;
	venvDir: typeof venvDir;
	listDevices: typeof listDevices;
	startRecording: typeof startRecording;
	transcribe: typeof transcribe;
	/**
	 * Classifier for the recording keys. Left undefined in production, where the real one is
	 * imported from pi-tui at session start; tests inject a stub instead.
	 */
	matchesKey?: (data: string, key: string) => boolean;
}

const realDeps: VoiceDeps = {
	loadConfig, saveConfig, runDiagnosis, runSetup, venvDir, listDevices, startRecording, transcribe,
};

type RecordingState = { kind: "recording"; handle: ActiveRecording; stopRequested: boolean };
type SessionState = { kind: "idle" } | RecordingState | { kind: "transcribing" };

/**
 * The part of a context the dictation helpers need.
 *
 * Keys arrive through the session context, not the command context, so the helpers take this
 * narrower shape and both remain assignable.
 */
type LiveContext = Pick<ExtensionContext, "ui">;

/**
 * Resolve pi's key matcher.
 *
 * pi-tui is not a dependency of this package — it only exists inside a running pi — so this is
 * a dynamic import, and a failure leaves the recording keys unbound rather than breaking the
 * extension. `/voice` still stops a recording in that case.
 */
async function loadMatchesKey(): Promise<((data: string, key: string) => boolean) | undefined> {
	try {
		const tui = (await import("@earendil-works/pi-tui")) as {
			matchesKey: (data: string, key: string) => boolean;
		};
		return (data, key) => tui.matchesKey(data, key);
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI, overrides: Partial<VoiceDeps> = {}): void {
	const deps: VoiceDeps = { ...realDeps, ...overrides };
	let state: SessionState = { kind: "idle" };
	let pulse: ReturnType<typeof setInterval> | undefined;
	let confirmTimer: ReturnType<typeof setTimeout> | undefined;
	/** Cached per session: probing spawns interpreters, so it is not repeated per dictation. */
	let diagnosis: EnvironmentReport | null = null;
	/** Resolved once per session, in the TUI only. Undefined leaves the keys with the editor. */
	let matchesKey: ((data: string, key: string) => boolean) | undefined;
	/** The transcriber process for the running transcription, so Escape can kill it. */
	let transcribeAbort: AbortController | undefined;

	const ensureReady = async (ctx: LiveContext, force = false): Promise<boolean> => {
		if (!diagnosis || force) diagnosis = await deps.runDiagnosis(deps.loadConfig());
		if (diagnosis.ready) return true;

		const text = describeProblems(diagnosis.problems, process.platform);
		ctx.ui.notify(text || "The environment is not ready for transcription.", "error");
		return false;
	};

	const clearPulse = () => {
		if (pulse) clearInterval(pulse);
		pulse = undefined;
	};

	const clearConfirm = () => {
		if (confirmTimer) clearTimeout(confirmTimer);
		confirmTimer = undefined;
	};

	const reset = (ctx: LiveContext, note: string, level: "info" | "warning" | "error") => {
		state = { kind: "idle" };
		clearPulse();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(note, level);
	};

	const runTranscription = async (ctx: LiveContext, pcmPath: string): Promise<void> => {
		state = { kind: "transcribing" };
		const modelCached = !diagnosis?.problems.some((p) => p.kind === "model_not_cached");
		ctx.ui.setStatus(
			STATUS_KEY,
			modelCached
				? "◌ transcribing… — Esc to stop"
				: "◌ transcribing… (first run downloads the model) — Esc to stop",
		);
		const controller = new AbortController();
		transcribeAbort = controller;
		try {
			const result = await deps.transcribe(pcmPath, effectiveConfig(deps.loadConfig(), diagnosis), {
				signal: controller.signal,
			});
			rmSync(pcmPath, { force: true });

			if (result.text.trim().length === 0) {
				reset(ctx, "Heard nothing. Try again a little closer to the microphone.", "warning");
				return;
			}

			ctx.ui.pasteToEditor(result.text);
			state = { kind: "idle" };
			clearPulse();
			ctx.ui.setStatus(STATUS_KEY, `✓ inserted (${result.elapsedSeconds.toFixed(1)}s)`);
			clearConfirm();
			confirmTimer = setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), CONFIRM_MS);
		} catch (err) {
			// Stopping on purpose is a decision, not a failure: nothing was lost that the user
			// wanted, so the audio goes with it instead of being advertised as kept.
			if (err instanceof TranscribeError && err.kind === "cancelled") {
				rmSync(pcmPath, { force: true });
				reset(ctx, "Transcription stopped. The recording was discarded.", "info");
				return;
			}

			// Keep the audio: a failed transcription must not also cost the recording,
			// so the path is part of the message.
			const detail = err instanceof TranscribeError && err.kind === "audio_unreadable"
				? err.detail
				: `${describeFailure(err)} — recording kept at ${pcmPath}`;
			reset(ctx, detail, "error");
		} finally {
			transcribeAbort = undefined;
		}
	};

	/** The maxSeconds cap ends a recording on its own, without the user stopping it. */
	const watchSelfTermination = (ctx: LiveContext, owner: RecordingState): void => {
		void owner.handle.ended.then(() => {
			if (state !== owner || owner.stopRequested) return;
			clearPulse();
			ctx.ui.notify("Recording limit reached; transcribing…", "warning");
			void runTranscription(ctx, owner.handle.pcmPath);
		});
	};

	const startDictation = async (ctx: LiveContext): Promise<void> => {
		// Checked before the microphone is touched, so a missing dependency never produces a
		// recording that cannot be transcribed.
		if (!(await ensureReady(ctx))) return;

		let handle: ActiveRecording;
		try {
			handle = await deps.startRecording(deps.loadConfig());
		} catch (err) {
			reset(ctx, err instanceof Error ? err.message : String(err), "error");
			return;
		}

		const owner: RecordingState = { kind: "recording", handle, stopRequested: false };
		state = owner;

		const render = () => {
			const seconds = Math.floor(handle.elapsedMs / 1000);
			const mm = Math.floor(seconds / 60);
			const ss = String(seconds % 60).padStart(2, "0");
			ctx.ui.setStatus(STATUS_KEY, `● recording ${mm}:${ss} — Enter to stop · Esc to cancel`);
		};
		render();
		pulse = setInterval(render, 1000);
		watchSelfTermination(ctx, owner);
	};

	const stopDictation = async (ctx: LiveContext, current: RecordingState): Promise<void> => {
		current.stopRequested = true;
		clearPulse();
		const recording = await current.handle.stop();

		let samples = 0;
		try {
			samples = statSync(recording.pcmPath).size / 2;
		} catch {
			reset(ctx, `Could not read the recording at ${recording.pcmPath}`, "error");
			return;
		}

		if (samples < deps.loadConfig().sampleRate * MIN_SECONDS) {
			rmSync(recording.pcmPath, { force: true });
			reset(ctx, "Nothing recorded.", "warning");
			return;
		}

		await runTranscription(ctx, recording.pcmPath);
	};

	/** The user stopping on purpose: no transcript, and nothing left on disk. */
	const cancelDictation = async (ctx: LiveContext, current: RecordingState): Promise<void> => {
		// Set before aborting: the recording resolves `ended` as it tears down, and the
		// self-termination watcher must not read that as the maxSeconds cap firing.
		current.stopRequested = true;
		clearPulse();
		await current.handle.abort();
		reset(ctx, "Recording discarded.", "info");
	};

	/**
	 * The recording keys, in front of the editor.
	 *
	 * Only Enter and Escape are ever taken, and only while a recording or a transcription owns
	 * the session; every other key — and every key while idle — reaches the editor untouched, so
	 * pi's own bindings keep working.
	 */
	const onTerminalInput = (ctx: LiveContext) => (data: string): { consume?: boolean } | undefined => {
		if (!matchesKey) return undefined;

		if (state.kind === "recording") {
			if (matchesKey(data, KEY_FINISH)) {
				void stopDictation(ctx, state);
				return { consume: true };
			}
			if (matchesKey(data, KEY_DISCARD)) {
				void cancelDictation(ctx, state);
				return { consume: true };
			}
			return undefined;
		}

		if (state.kind === "transcribing") {
			// Enter is held back deliberately: the transcript is about to land in the editor, and
			// submitting before it does would send the prompt without it.
			if (matchesKey(data, KEY_FINISH)) {
				ctx.ui.notify("Still transcribing the previous recording.", "warning");
				return { consume: true };
			}
			if (matchesKey(data, KEY_DISCARD)) {
				transcribeAbort?.abort();
				return { consume: true };
			}
		}

		return undefined;
	};

	const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/voice requires interactive mode", "error");
			return;
		}

		const sub = args.trim().toLowerCase();

		if (sub === "cancel") {
			if (state.kind === "recording") {
				await cancelDictation(ctx, state);
			} else {
				ctx.ui.notify("Nothing to cancel.", "info");
			}
			return;
		}

		if (sub === "status") {
			ctx.ui.notify(
				state.kind === "recording"
					? `recording, ${Math.round(state.handle.elapsedMs / 1000)}s elapsed`
					: `${state.kind}, model ${deps.loadConfig().model}`,
				"info",
			);
			return;
		}

		if (sub === "config") {
			ctx.ui.notify(JSON.stringify(deps.loadConfig(), null, "\t"), "info");
			return;
		}

		if (sub === "devices") {
			const devices = await deps.listDevices();
			ctx.ui.notify(
				devices.length === 0
					? "No audio input devices found."
					: devices.map((name, index) => `[${index}] ${name}`).join("\n"),
				"info",
			);
			return;
		}

		if (sub === "doctor") {
			diagnosis = await deps.runDiagnosis(deps.loadConfig());
			const config = deps.loadConfig();
			const facts = [
				`candidates tried: ${diagnosis.candidatesTried.join(", ") || "none"}`,
				diagnosis.probe
					? `using: ${diagnosis.probe.command.join(" ")} (${diagnosis.probe.version})`
					: "using: none",
				`faster-whisper: ${diagnosis.probe?.hasFasterWhisper ? `yes (${diagnosis.probe.fasterWhisperVersion})` : "no"}`,
				`model cached: ${diagnosis.problems.some((p) => p.kind === "model_not_cached") ? "no" : "yes"}`,
				`chinese script: ${planLanguage(config.language).steering ?? "off"}`,
			];
			// Candidates that ran but could not be probed are worth naming: a hanging or
			// half-installed interpreter would otherwise be invisible.
			if (diagnosis.probeNotes.length > 0) facts.push(`notes: ${diagnosis.probeNotes.join("; ")}`);

			const problems = describeProblems(diagnosis.problems, process.platform);
			ctx.ui.notify(
				`${facts.join("\n")}\n\n${problems || "Environment is ready."}`,
				diagnosis.ready ? "info" : "error",
			);
			return;
		}

		if (sub === "setup") {
			if (state.kind === "recording") {
				ctx.ui.notify("Stop the recording first.", "warning");
				return;
			}

			const venv = deps.venvDir(process.env, homedir());
			ctx.ui.notify(
				`Setting up a Python environment in ${venv}. This downloads a few hundred MB and can take a few minutes.`,
				"info",
			);

			const result = await deps.runSetup({
				venvDir: venv,
				onProgress: (_stage, message) => ctx.ui.setStatus(STATUS_KEY, `◌ ${message}`),
			});
			ctx.ui.setStatus(STATUS_KEY, undefined);

			if (result.ok) {
				deps.saveConfig({ python: result.python });
				diagnosis = null; // force a re-probe next time
				ctx.ui.notify(
					`Installed faster-whisper ${result.detail} for ${result.python}.\n` +
						"The first dictation will download the speech model.",
					"info",
				);
			} else {
				ctx.ui.notify([result.detail, ...result.commands].filter(Boolean).join("\n"), "error");
			}
			return;
		}

		if (sub !== "") {
			ctx.ui.notify(`Unknown subcommand "${sub}". Try: /voice, cancel, status, devices, config`, "error");
			return;
		}

		if (state.kind === "transcribing") {
			ctx.ui.notify("Still transcribing the previous recording.", "warning");
			return;
		}

		if (state.kind === "recording") {
			await stopDictation(ctx, state);
			return;
		}

		await startDictation(ctx);
	};

	pi.registerCommand("voice", {
		description: "Record and transcribe speech into the editor using local faster-whisper",
		getArgumentCompletions: (prefix: string) => {
			const items = ["cancel", "status", "devices", "config", "doctor", "setup"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler,
	});

	pi.on("session_start", async (_event, ctx) => {
		// Raw terminal input exists only in the TUI, and pi-tui is only importable from inside
		// pi. Without a matcher the recording keys stay unbound: `/voice` still stops a
		// recording, so nothing is unreachable.
		if (ctx.mode !== "tui") return;
		matchesKey = deps.matchesKey ?? (await loadMatchesKey());
		if (!matchesKey) return;

		ctx.ui.onTerminalInput(onTerminalInput(ctx));
	});

	pi.on("session_shutdown", async () => {
		clearPulse();
		clearConfirm();
		transcribeAbort?.abort();
		if (state.kind === "recording") await state.handle.abort();
	});
}
