import type { VoiceConfig } from "./config.ts";

/** Minimum interpreter. faster-whisper requires 3.9+. */
const MIN_MAJOR = 3;
const MIN_MINOR = 9;

export interface PythonCandidate {
	command: string[];
	label: string;
}

/**
 * Interpreters to try, best first.
 *
 * Windows has no `python3` unless the user created one, and the `py` launcher is the
 * documented way to reach a 3.x install, so it leads there. Elsewhere `python3` is the
 * conventional name; on macOS it may resolve to a pyenv shim, a Homebrew interpreter, or the
 * Xcode stub, which is exactly why every candidate is probed rather than the first being
 * trusted.
 */
export function pythonCandidates(platform: NodeJS.Platform): PythonCandidate[] {
	const commands: string[][] =
		platform === "win32"
			? [["py", "-3"], ["python"]]
			: [["python3"], ["python3.13"], ["python3.12"], ["python3.11"], ["python3.10"], ["python"]];

	const seen = new Set<string>();
	const out: PythonCandidate[] = [];
	for (const command of commands) {
		const key = command.join(" ");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ command, label: key });
	}
	return out;
}

export interface PythonProbe {
	command: string[];
	version: string | null;
	supported: boolean;
	hasFasterWhisper: boolean;
	fasterWhisperVersion: string | null;
	hasPip: boolean;
	/** Why something was missing, for the doctor. */
	detail: string;
}

export function isSupportedVersion(version: string | null): boolean {
	if (!version) return false;
	const parts = version.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return false;
	if (parts[0] !== MIN_MAJOR) return parts[0] > MIN_MAJOR;
	return parts[1] >= MIN_MINOR;
}

interface RawProbe {
	version?: unknown;
	fw?: unknown;
	pip?: unknown;
	fwError?: unknown;
}

/**
 * Parse the single JSON line the probe script prints.
 *
 * Tolerates surrounding noise, and takes the last parseable line rather than rejecting the
 * whole stream: wrapper scripts and some interpreters print banners on stdout, which would
 * otherwise make a working interpreter look broken.
 */
export function parseProbe(stdout: string): Omit<PythonProbe, "command"> | null {
	const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);

	for (let i = lines.length - 1; i >= 0; i--) {
		let raw: RawProbe;
		try {
			raw = JSON.parse(lines[i]) as RawProbe;
		} catch {
			continue;
		}
		if (typeof raw !== "object" || raw === null || typeof raw.version !== "string") continue;

		const fw = typeof raw.fw === "string" && raw.fw.length > 0 ? raw.fw : null;
		return {
			version: raw.version,
			supported: isSupportedVersion(raw.version),
			hasFasterWhisper: fw !== null,
			fasterWhisperVersion: fw,
			hasPip: typeof raw.pip === "string" && raw.pip.length > 0,
			detail: typeof raw.fwError === "string" ? raw.fwError : "",
		};
	}

	return null;
}

export type ProblemKind =
	| "no_python"
	| "python_too_old"
	| "no_pip"
	| "no_faster_whisper"
	| "no_recorder"
	| "model_not_cached";

export interface Problem {
	kind: ProblemKind;
	summary: string;
	/**
	 * True when `/voice setup` can resolve it, which decides what the copy recommends.
	 * Setup creates a venv and runs pip, so it can supply pip and faster-whisper and nothing
	 * else: not an interpreter, and not an npm package.
	 */
	setupFixes: boolean;
	manualCommands: string[];
}

export interface ModelStatus {
	name: string;
	cached: boolean;
}

function pipCommand(platform: NodeJS.Platform): string {
	return platform === "win32" ? "py -3 -m pip" : "pip3";
}

/**
 * Copy-paste commands for a problem on a given platform.
 *
 * The alternative to `/voice setup`, never a replacement for it, and deliberately concrete:
 * "install Python" is not actionable, `brew install python@3.12` is.
 */
export function remediation(problem: Problem, platform: NodeJS.Platform): string[] {
	switch (problem.kind) {
		case "no_python":
			if (platform === "darwin") {
				return ["brew install python@3.12", "or install Apple's command line tools: xcode-select --install"];
			}
			if (platform === "win32") {
				return ["winget install Python.Python.3.12", "or download it from https://www.python.org/downloads/"];
			}
			return ["sudo apt install python3 python3-pip", "or your distribution's equivalent"];

		case "python_too_old": {
			const install =
				platform === "darwin"
					? "brew install python@3.12"
					: platform === "win32"
						? "winget install Python.Python.3.12"
						: "sudo apt install python3 python3-pip";
			return [`faster-whisper needs Python ${MIN_MAJOR}.${MIN_MINOR} or newer`, install];
		}

		case "no_pip":
			return ["python3 -m ensurepip --upgrade", `${pipCommand(platform)} --version   # to check`];

		case "no_faster_whisper":
			return [`${pipCommand(platform)} install faster-whisper`];

		case "no_recorder":
			return ["npm install", "(run it in the pi-voice project directory)"];

		case "model_not_cached":
			// Informational: the first transcription downloads it. Nothing to run.
			return [];
	}
}

/**
 * Turn probe results into an ordered problem list.
 *
 * Every problem is reported rather than just the first, so the doctor never sends a user
 * round the loop one dependency at a time. `model_not_cached` is listed for visibility but
 * carries no commands and is not a blocker, because a download is not a failure.
 */
export function diagnose(probe: PythonProbe | null, recorderOk: boolean, model: ModelStatus): Problem[] {
	const problems: Problem[] = [];

	if (!probe) {
		problems.push({
			kind: "no_python",
			summary: "No Python interpreter was found.",
			setupFixes: false,
			manualCommands: [],
		});
	} else {
		if (!probe.supported) {
			// Deliberately only this one. Facts about the pip and faster-whisper of an interpreter
			// the user is about to replace are noise, and stating them invites installing the
			// package into the interpreter that is being retired.
			problems.push({
				kind: "python_too_old",
				summary: `Python ${probe.version} is too old; faster-whisper needs ${MIN_MAJOR}.${MIN_MINOR} or newer.`,
				setupFixes: false,
				manualCommands: [],
			});
		} else {
			if (!probe.hasPip) {
			problems.push({
				kind: "no_pip",
				summary: `The Python ${probe.version} that was found has no usable pip.`,
				setupFixes: true,
				manualCommands: [],
			});
			}
			if (!probe.hasFasterWhisper) {
				const where = probe.command.join(" ");
				const version = probe.version ? ` (${probe.version})` : "";
				problems.push({
					kind: "no_faster_whisper",
					summary: `faster-whisper is not installed for ${where}${version}.`,
					setupFixes: true,
					manualCommands: [],
				});
			}
		}
	}

	if (!recorderOk) {
		problems.push({
			kind: "no_recorder",
			summary: "The audio recorder module is not installed.",
			setupFixes: false,
			manualCommands: [],
		});
	}

	if (!model.cached) {
		problems.push({
			kind: "model_not_cached",
			summary: `Model "${model.name}" is not cached; the first transcription will download it.`,
			setupFixes: false,
			manualCommands: [],
		});
	}

	return problems;
}

/**
 * Where a model lives in the Hugging Face cache.
 *
 * A model given as a filesystem path is not a hub id, so it is returned unchanged and the
 * caller checks the path itself.
 */
export function modelCacheDir(model: string, home: string, xdgCacheHome: string | undefined): string {
	const isPath =
		model.startsWith("/") ||
		model.startsWith("./") ||
		model.startsWith("../") ||
		/^[A-Za-z]:[\\/]/.test(model);
	if (isPath) return model;

	const base = xdgCacheHome && xdgCacheHome.trim().length > 0 ? xdgCacheHome.trim() : `${home}/.cache`;
	return `${base}/huggingface/hub/models--Systran--faster-whisper-${model}`;
}

/**
 * The interpreter transcription must actually use.
 *
 * `runDiagnosis` may settle on a different interpreter than the configured one — that is the
 * point of the candidate scan, since `python3` may not exist while `python3.12` does. But
 * `transcribe()` spawns `cfg.python`, so if the two disagree the doctor can report a healthy
 * environment and the very next dictation fails. Resolving the config through the diagnosis
 * keeps the thing that was checked and the thing that is used identical.
 */
export function effectiveConfig(cfg: VoiceConfig, report: EnvironmentReport | null): VoiceConfig {
	const interpreter = report?.probe?.command.join(" ").trim();
	if (!interpreter || interpreter === cfg.python) return cfg;
	return { ...cfg, python: interpreter };
}

export interface EnvironmentReport {
	ready: boolean;
	probe: PythonProbe | null;
	candidatesTried: string[];
	/** Candidates that ran but could not be probed, with the reason. Surfaced by the doctor. */
	probeNotes: string[];
	problems: Problem[];
}

/**
 * An uncached model does not make the environment unready: the first transcription downloads
 * it, so refusing to record over it would be wrong.
 */
export function environmentReady(problems: Problem[]): boolean {
	return problems.every((p) => p.kind === "model_not_cached");
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/**
 * One probe per candidate, printing a single JSON line.
 *
 * Everything is gathered in one process because spawning is the expensive part: three
 * imports in one interpreter costs a fraction of three interpreters. The script exits 0
 * whenever the interpreter runs at all, so a missing package is data rather than an error.
 */
const PROBE_SCRIPT = [
	"import json, sys",
	"r = {'version': '%d.%d.%d' % sys.version_info[:3]}",
	"r['fw'] = None",
	"r['pip'] = None",
	"try:",
	"    import faster_whisper",
	"    r['fw'] = getattr(faster_whisper, '__version__', 'unknown')",
	"except Exception as e:",
	"    r['fwError'] = type(e).__name__",
	"try:",
	"    import pip",
	"    r['pip'] = getattr(pip, '__version__', 'unknown')",
	"except Exception:",
	"    pass",
	"print(json.dumps(r))",
].join("\n");

interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** errno from the spawn `error` event, e.g. ENOENT or EACCES. */
	spawnErrorCode: string | null;
}

/**
 * Time allowed for one probe.
 *
 * Generous on purpose. The probe imports faster-whisper, which loads ctranslate2 and
 * onnxruntime; from a cold cache that took 24.5s on this machine immediately after an
 * install, and an earlier 20s limit turned a working venv into a bogus "could not be run"
 * failure. A missing package is still fast — an ImportError costs milliseconds — so this
 * only bounds genuine hangs.
 */
export const PROBE_TIMEOUT_MS = 60_000;

function exec(command: string, args: string[], timeoutMs: number): Promise<ExecResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		const settle = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? null;
			resolve({ code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false, spawnErrorCode: code });
			return;
		}

		const timer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { /* already gone */ }
			settle({ code: null, stdout, stderr, timedOut: true, spawnErrorCode: null });
		}, timeoutMs);

		child.stdout?.on("data", (d) => { stdout += String(d); });
		child.stderr?.on("data", (d) => { stderr += String(d); });
		child.once("error", (err: NodeJS.ErrnoException) => {
			settle({ code: null, stdout, stderr: err.message, timedOut: false, spawnErrorCode: err.code ?? null });
		});
		child.once("close", (code) => settle({ code, stdout, stderr, timedOut: false, spawnErrorCode: null }));
	});
}

/**
 * Why a probe did not produce a usable interpreter.
 *
 * Kept distinct because the three cases need different responses: `not_found` means try the
 * next candidate, `timeout` means the interpreter is too slow to be usable, and `no_output`
 * means it ran but told us nothing — a crash or a wrapper script.
 */
export type ProbeFailureReason = "not_found" | "timeout" | "no_output";

export type ProbeOutcome =
	| { ok: true; probe: PythonProbe }
	| { ok: false; reason: ProbeFailureReason; detail: string };

/** Probe one interpreter. */
export async function probePython(
	candidate: PythonCandidate,
	timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
	const [command, ...prefix] = candidate.command;
	const result = await exec(command, [...prefix, "-c", PROBE_SCRIPT], timeoutMs);

	const parsed = parseProbe(result.stdout);
	if (parsed) {
		const stderrTail = result.stderr.trim().split("\n").filter(Boolean).pop() ?? "";
		return { ok: true, probe: { command: candidate.command, ...parsed, detail: parsed.detail || stderrTail } };
	}

	if (result.timedOut) {
		return { ok: false, reason: "timeout", detail: `no response within ${Math.round(timeoutMs / 1000)}s` };
	}

	// A command that cannot be spawned reports through the `error` event, not through stderr
	// text, so the errno is what distinguishes "try the next candidate" from "this interpreter
	// ran but told us nothing".
	if (result.spawnErrorCode === "ENOENT" || result.spawnErrorCode === "EACCES") {
		return { ok: false, reason: "not_found", detail: result.spawnErrorCode };
	}

	const stderrTail = result.stderr.trim().split("\n").filter(Boolean).pop() ?? "";
	if (stderrTail.length === 0 && result.stdout.trim().length === 0) {
		return { ok: false, reason: "not_found", detail: "command not found" };
	}

	return { ok: false, reason: "no_output", detail: stderrTail || result.stdout.trim().slice(0, 200) };
}

export function checkModelCached(model: string): boolean {
	const computed = modelCacheDir(model, homedir(), process.env.XDG_CACHE_HOME);
	// modelCacheDir echoes a filesystem path back unchanged; otherwise it is a hub directory.
	return existsSync(computed);
}

async function recorderAvailable(): Promise<boolean> {
	try {
		const { listDevices } = await import("./recorder.ts");
		await listDevices();
		return true;
	} catch {
		return false;
	}
}

/**
 * Probe the environment once.
 *
 * The configured interpreter is tried first, because the whole point of `/voice setup` is
 * that it points the config at a venv which has faster-whisper. A configured interpreter
 * that no longer works falls through to the candidate list instead of becoming a dead end.
 */
export async function runDiagnosis(cfg: VoiceConfig): Promise<EnvironmentReport> {
	const candidates = pythonCandidates(process.platform);

	const configured = cfg.python.trim();
	if (configured.length > 0) {
		const words = configured.split(/\s+/).filter(Boolean);
		const alreadyListed = candidates.some((c) => c.command.join(" ") === words.join(" "));
		if (words.length > 0 && !alreadyListed) {
			candidates.unshift({ command: words, label: words.join(" ") });
		}
	}

	const candidatesTried: string[] = [];
	const probeNotes: string[] = [];
	let chosen: PythonProbe | null = null;

	for (const candidate of candidates) {
		candidatesTried.push(candidate.label);
		const outcome = await probePython(candidate);
		if (!outcome.ok) {
			if (outcome.reason === "not_found") continue;
			// A candidate that runs but cannot answer is worth reporting: it is the usual shape
			// of a broken or hanging interpreter, and silence about it wastes the user's time.
			probeNotes.push(`${candidate.label}: ${outcome.reason} (${outcome.detail})`);
			continue;
		}
		// Keep the first usable interpreter, but prefer one that can actually transcribe.
		if (!chosen) chosen = outcome.probe;
		if (outcome.probe.supported && outcome.probe.hasFasterWhisper) {
			chosen = outcome.probe;
			break;
		}
	}

	const recorderOk = await recorderAvailable();
	const problems = diagnose(chosen, recorderOk, { name: cfg.model, cached: checkModelCached(cfg.model) });

	return { ready: environmentReady(problems), probe: chosen, candidatesTried, probeNotes, problems };
}
