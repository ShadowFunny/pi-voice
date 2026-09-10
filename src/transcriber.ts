import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTranscribeArgs } from "./args.ts";
import type { VoiceConfig } from "./config.ts";
import { planLanguage, type ScriptSteering } from "./language.ts";

export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
}

export interface Transcript {
	text: string;
	language: string;
	languageProbability: number;
	durationSeconds: number;
	elapsedSeconds: number;
	/** Which script was steered, or null when Whisper's own output was left alone. */
	scriptSteering: ScriptSteering | null;
	segments: TranscriptSegment[];
}

export type TranscribeErrorKind =
	| "no_faster_whisper"
	| "model_unavailable"
	| "audio_unreadable"
	| "python_failed"
	| "python_missing"
	| "protocol"
	/** Stopped on purpose: the caller aborted, so this is not a failure to report. */
	| "cancelled";

export class TranscribeError extends Error {
	kind: TranscribeErrorKind;
	detail: string;

	constructor(kind: TranscribeErrorKind, detail: string) {
		super(detail);
		this.name = "TranscribeError";
		this.kind = kind;
		this.detail = detail;
	}
}

/** python/transcribe.py sits beside src/ inside the extension directory. */
export function scriptPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "python", "transcribe.py");
}

interface ErrorPayload {
	error?: { kind?: unknown; message?: unknown };
}

export interface TranscribeCallOptions {
	/** Aborting kills the transcriber process and rejects with a `cancelled` error. */
	signal?: AbortSignal;
}

function parse(stdout: string): Record<string, unknown> | null {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) return null;
	try {
		const value: unknown = JSON.parse(trimmed);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function transcribe(
	pcmPath: string,
	cfg: VoiceConfig,
	options: TranscribeCallOptions = {},
): Promise<Transcript> {
	// The language code the user wrote and the code Whisper accepts are not the same thing, and
	// the script they asked for rides along as a prompt rather than as a language.
	const plan = planLanguage(cfg.language, cfg.simplifiedChinese);

	return new Promise((resolve, reject) => {
		const args = buildTranscribeArgs({
			pcmPath,
			scriptPath: scriptPath(),
			python: cfg.python,
			model: cfg.model,
			language: plan.whisper,
			beamSize: cfg.beamSize,
			computeType: cfg.computeType,
			cpuThreads: cfg.cpuThreads,
			vad: cfg.vad,
			initialPrompt: cfg.initialPrompt,
			sampleRate: cfg.sampleRate,
			steering: plan.steering,
		});

		const proc = spawn(cfg.python, args, { stdio: ["ignore", "pipe", "pipe"], signal: options.signal });

		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
		proc.stderr.on("data", (chunk) => { stderr += String(chunk); });

		proc.once("error", (err: NodeJS.ErrnoException) => {
			finish(() => {
				// Node reports an aborted spawn as an AbortError, which is a deliberate stop
				// rather than something that went wrong.
				if (err.name === "AbortError") {
					reject(new TranscribeError("cancelled", "stopped before it finished"));
				} else if (err.code === "ENOENT") {
					reject(new TranscribeError("python_missing", cfg.python));
				} else {
					reject(new TranscribeError("python_failed", err.message));
				}
			});
		});

		proc.once("close", (code) => {
			finish(() => {
				// Killed before it could report: a stopped transcription is not a transcriber
				// failure, and its partial stdout must not be parsed as one.
				if (options.signal?.aborted) {
					reject(new TranscribeError("cancelled", "stopped before it finished"));
					return;
				}

				const payload = parse(stdout) as (Record<string, unknown> & ErrorPayload) | null;

				// The script reports its own failures as a `kind`, which is more
				// precise than the exit code, so prefer it.
				const reported = payload?.error;
				if (reported && typeof reported.kind === "string") {
					const message = typeof reported.message === "string" ? reported.message : "";
					reject(new TranscribeError(reported.kind as TranscribeErrorKind, message));
					return;
				}

				if (code !== 0) {
					reject(new TranscribeError("python_failed", stderr.trim() || `exit code ${code}`));
					return;
				}

				if (!payload || typeof payload.text !== "string") {
					reject(new TranscribeError("protocol", `unexpected stdout: ${stdout.slice(0, 200)}`));
					return;
				}

				resolve({
					text: payload.text,
					language: typeof payload.language === "string" ? payload.language : "",
					languageProbability: typeof payload.languageProbability === "number" ? payload.languageProbability : 0,
					durationSeconds: typeof payload.durationSeconds === "number" ? payload.durationSeconds : 0,
					elapsedSeconds: typeof payload.elapsedSeconds === "number" ? payload.elapsedSeconds : 0,
					scriptSteering:
						payload.scriptSteering === "simplified" || payload.scriptSteering === "traditional"
							? payload.scriptSteering
							: null,
					segments: Array.isArray(payload.segments) ? (payload.segments as TranscriptSegment[]) : [],
				});
			});
		});
	});
}

/**
 * Map a failure to actionable copy.
 *
 * Deliberately never mentions permissions: the whole reason this extension exists
 * is that a missing native audio library was reported as a microphone permission
 * problem, which sent the user down the wrong path.
 */
export function describeFailure(err: unknown): string {
	if (err instanceof TranscribeError) {
		switch (err.kind) {
			case "no_faster_whisper":
				return "faster-whisper is not installed. Run: pip3 install faster-whisper";
			case "python_missing":
				return `python3 not found ("${err.detail}"). Set the "python" key via /voice config.`;
			case "model_unavailable":
				return `Whisper model unavailable: ${err.detail}`;
			case "audio_unreadable":
				return `Could not read the recording. It was kept at ${err.detail}`;
			case "python_failed":
				return `Transcription failed: ${err.detail}`;
			case "protocol":
				return "Transcription failed: the transcriber returned unexpected output.";
			case "cancelled":
				return "Transcription stopped.";
		}
	}
	return err instanceof Error ? err.message : String(err);
}
