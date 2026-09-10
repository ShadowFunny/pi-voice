/**
 * Paths and argument lists for `/voice setup`.
 *
 * Kept pure and separate from running the commands so the parts that are easy to get wrong —
 * the XDG default, the Windows `Scripts` layout, and preserving the `py -3` prefix — are
 * unit-tested without creating a real virtual environment, which takes tens of seconds.
 */

export function dataDir(env: NodeJS.ProcessEnv, home: string): string {
	const xdg = env.XDG_DATA_HOME?.trim();
	return xdg && xdg.length > 0 ? xdg : `${home}/.local/share`;
}

/**
 * The venv lives in the user's data directory, never in the project.
 *
 * Keeping it out of the repository means it cannot be committed by accident, and it survives
 * the project being moved or re-cloned.
 */
export function venvDir(env: NodeJS.ProcessEnv, home: string): string {
	return `${dataDir(env, home)}/pi-voice/venv`;
}

export function venvPython(venv: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? `${venv}\\Scripts\\python.exe` : `${venv}/bin/python`;
}

function pythonArgs(python: string[]): string[] {
	// Everything after the executable is a prefix that must be preserved: `py -3` is
	// `["py", "-3"]`, and dropping "-3" would select whatever Python the launcher defaults to.
	const [, ...prefix] = python;
	return prefix;
}

export function buildVenvArgs(python: string[], venv: string): string[] {
	return [...pythonArgs(python), "-m", "venv", venv];
}

export function buildPipInstallArgs(python: string[], packages: string[]): string[] {
	return [...pythonArgs(python), "-m", "pip", "install", "--disable-pip-version-check", ...packages];
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	PROBE_TIMEOUT_MS,
	type PythonCandidate,
	probePython,
	pythonCandidates,
	remediation,
} from "./environment.ts";

export type SetupStage = "probe" | "venv" | "install" | "verify";

export interface SetupResult {
	ok: boolean;
	reason?: "no_python" | "venv_failed" | "install_failed" | "verify_failed";
	/** The interpreter to record in the config. Empty when setup failed before creating one. */
	python: string;
	/** Detail for the user: installed version on success, command output on failure. */
	detail: string;
	/** Commands to show when setup could not do the job itself. */
	commands: string[];
}

export interface SetupOptions {
	candidates?: PythonCandidate[];
	venvDir: string;
	onProgress: (stage: SetupStage, message: string) => void;
	pythonPathResolver?: (venv: string) => string;
}

interface RunResult {
	code: number | null;
	output: string;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
	return new Promise((resolve) => {
		let output = "";
		let settled = false;

		const settle = (result: RunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ code: null, output: err instanceof Error ? err.message : String(err) });
			return;
		}

		const timer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { /* already gone */ }
			settle({ code: null, output: `${output}\ntimed out after ${timeoutMs}ms` });
		}, timeoutMs);

		child.stdout?.on("data", (d) => { output += String(d); });
		child.stderr?.on("data", (d) => { output += String(d); });
		child.once("error", (err) => settle({ code: null, output: `${output}\n${err.message}` }));
		child.once("close", (code) => settle({ code, output }));
	});
}

function tail(text: string, lines = 6): string {
	return text.trim().split("\n").filter(Boolean).slice(-lines).join("\n");
}

/**
 * Create a virtual environment and install faster-whisper into it.
 *
 * Deliberately unable to install Python: that needs an installer, elevation, and a choice of
 * distribution, so when no usable interpreter exists this stops with the platform command
 * rather than attempting to bootstrap one. Idempotent by construction — re-running over an
 * existing venv reinstalls and re-verifies, which is also the documented fix for a broken
 * environment.
 */
export async function runSetup(options: SetupOptions): Promise<SetupResult> {
	const candidates = options.candidates ?? pythonCandidates(process.platform);
	const resolveVenvPython = options.pythonPathResolver ?? ((venv: string) => venvPython(venv, process.platform));

	options.onProgress("probe", "Looking for a Python interpreter…");
	let chosen: PythonCandidate | null = null;
	for (const candidate of candidates) {
		const outcome = await probePython(candidate);
		if (outcome.ok && outcome.probe.supported) {
			chosen = candidate;
			break;
		}
	}

	if (!chosen) {
		return {
			ok: false,
			reason: "no_python",
			python: "",
			detail: "No usable Python interpreter was found.",
			commands: remediation(
				{ kind: "no_python", summary: "", setupFixes: false, manualCommands: [] },
				process.platform,
			),
		};
	}

	options.onProgress("venv", `Creating a virtual environment in ${options.venvDir}…`);
	const venvResult = await runCommand(chosen.command[0], buildVenvArgs(chosen.command, options.venvDir), 300_000);
	const venvInterpreter = resolveVenvPython(options.venvDir);

	if (venvResult.code !== 0 || !existsSync(venvInterpreter)) {
		return {
			ok: false,
			reason: "venv_failed",
			python: "",
			detail: tail(venvResult.output),
			commands: [],
		};
	}

	options.onProgress("install", "Installing faster-whisper (downloads a few hundred MB)…");
	const installResult = await runCommand(
		venvInterpreter,
		buildPipInstallArgs([venvInterpreter], ["--upgrade", "pip", "faster-whisper"]),
		900_000,
	);
	if (installResult.code !== 0) {
		return {
			ok: false,
			reason: "install_failed",
			python: venvInterpreter,
			detail: tail(installResult.output),
			commands: [`${venvInterpreter} -m pip install faster-whisper`],
		};
	}

	options.onProgress("verify", "Verifying the installation…");
	// The same check the doctor runs, so an install that reports success but cannot be
	// imported is caught here instead of at the user's first dictation. The timeout is
	// doubled because this import is the coldest one there is: the wheels were written
	// moments ago.
	const verify = await probePython({ command: [venvInterpreter], label: venvInterpreter }, PROBE_TIMEOUT_MS * 2);
	if (!verify.ok) {
		return {
			ok: false,
			reason: "verify_failed",
			python: venvInterpreter,
			detail:
				verify.reason === "timeout"
					? `the freshly installed interpreter did not respond within ${Math.round((PROBE_TIMEOUT_MS * 2) / 1000)}s (${verify.detail})`
					: `the installed interpreter could not be queried: ${verify.detail}`,
			commands: [`${venvInterpreter} -c "import faster_whisper; print(faster_whisper.__version__)"`],
		};
	}
	if (!verify.probe.hasFasterWhisper) {
		return {
			ok: false,
			reason: "verify_failed",
			python: venvInterpreter,
			detail: `pip reported success but importing faster-whisper failed: ${verify.probe.detail || "no detail"}`,
			commands: [`${venvInterpreter} -m pip install faster-whisper`],
		};
	}

	return {
		ok: true,
		python: venvInterpreter,
		detail: verify.probe.fasterWhisperVersion ?? "",
		commands: [],
	};
}
