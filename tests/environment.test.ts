import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	diagnose,
	effectiveConfig,
	modelCacheDir,
	parseProbe,
	pythonCandidates,
	remediation,
	type PythonProbe,
} from "../src/environment.ts";

const OK_PROBE: PythonProbe = {
	command: ["python3"],
	version: "3.13.2",
	supported: true,
	hasFasterWhisper: true,
	fasterWhisperVersion: "1.2.1",
	hasPip: true,
	detail: "",
};
const model = { name: "base", cached: true };

test("pythonCandidates prefers py -3 on Windows and python3 elsewhere", () => {
	const win = pythonCandidates("win32").map((c) => c.command.join(" "));
	assert.equal(win[0], "py -3");
	assert.ok(win.includes("python"));
	assert.ok(!win.includes("python3"));

	const mac = pythonCandidates("darwin").map((c) => c.command.join(" "));
	assert.equal(mac[0], "python3");
	assert.ok(mac.some((c) => c.startsWith("python3.")), "should try versioned interpreters");
});

test("pythonCandidates returns labelled candidates with no duplicates", () => {
	for (const platform of ["darwin", "win32", "linux"] as const) {
		const seen = new Set<string>();
		for (const c of pythonCandidates(platform)) {
			assert.ok(c.command.length > 0);
			assert.ok(c.label.length > 0);
			const key = c.command.join(" ");
			assert.ok(!seen.has(key), `duplicate candidate ${key}`);
			seen.add(key);
		}
	}
});

test("parseProbe reads the JSON the probe script prints", () => {
	const probe = parseProbe('{"version":"3.11.9","fw":"1.2.1","pip":"24.0"}');
	assert.equal(probe?.version, "3.11.9");
	assert.equal(probe?.hasFasterWhisper, true);
	assert.equal(probe?.fasterWhisperVersion, "1.2.1");
	assert.equal(probe?.hasPip, true);
	assert.equal(probe?.supported, true);
});

test("parseProbe treats a missing package as missing, not as failure", () => {
	const probe = parseProbe('{"version":"3.13.2","fw":null,"pip":null,"fwError":"ModuleNotFoundError"}');
	assert.equal(probe?.hasFasterWhisper, false);
	assert.equal(probe?.fasterWhisperVersion, null);
	assert.equal(probe?.hasPip, false);
	assert.equal(probe?.supported, true);
	assert.match(probe?.detail ?? "", /ModuleNotFoundError/);
});

test("parseProbe rejects garbage and tolerates extra output", () => {
	assert.equal(parseProbe(""), null);
	assert.equal(parseProbe("not json"), null);
	assert.equal(parseProbe('{"nope":1}'), null);
	// A stray banner line before the JSON must not defeat the parse.
	const noisy = 'some warning\n{"version":"3.12.1","fw":null,"pip":"24.0"}\n';
	assert.equal(parseProbe(noisy)?.version, "3.12.1");
});

test("parseProbe marks old interpreters unsupported", () => {
	assert.equal(parseProbe('{"version":"3.8.10","fw":null,"pip":null}')?.supported, false);
	assert.equal(parseProbe('{"version":"3.9.0","fw":null,"pip":null}')?.supported, true);
	assert.equal(parseProbe('{"version":"4.0.0","fw":null,"pip":null}')?.supported, true);
});

test("diagnose reports nothing for a ready environment", () => {
	assert.deepEqual(diagnose(OK_PROBE, true, model), []);
});

test("diagnose reports no_python with no probe", () => {
	const problems = diagnose(null, true, model);
	assert.deepEqual(problems.map((p) => p.kind), ["no_python"]);
});

test("diagnose collects every problem for a supported interpreter, not just the first", () => {
	const noPipNoFw: PythonProbe = { ...OK_PROBE, hasFasterWhisper: false, fasterWhisperVersion: null, hasPip: false };
	const kinds = diagnose(noPipNoFw, false, { name: "base", cached: false }).map((p) => p.kind);
	assert.deepEqual(kinds, ["no_pip", "no_faster_whisper", "no_recorder", "model_not_cached"]);
});

test("diagnose reports only python_too_old for an unsupported interpreter", () => {
	// The pip and faster-whisper status of an interpreter about to be replaced is noise, and
	// repeating it would invite installing the package into the interpreter being retired.
	const old: PythonProbe = { ...OK_PROBE, version: "3.8.10", supported: false, hasFasterWhisper: false, hasPip: false };
	assert.deepEqual(diagnose(old, true, model).map((p) => p.kind), ["python_too_old"]);
});

test("diagnose never treats an uncached model as a setup problem", () => {
	const problems = diagnose(OK_PROBE, true, { name: "medium", cached: false });
	assert.deepEqual(problems.map((p) => p.kind), ["model_not_cached"]);
	assert.equal(problems[0].setupFixes, false, "setup does not download models");
	assert.deepEqual(problems[0].manualCommands, []);
});

test("only pip and faster-whisper are declared fixable by setup", () => {
	const noPipNoFw: PythonProbe = { ...OK_PROBE, hasFasterWhisper: false, fasterWhisperVersion: null, hasPip: false };
	const byKind = Object.fromEntries(
		diagnose(noPipNoFw, false, { name: "base", cached: true }).map((p) => [p.kind, p.setupFixes]),
	);
	assert.equal(byKind.no_faster_whisper, true);
	assert.equal(byKind.no_pip, true);
	assert.equal(byKind.no_recorder, false, "setup does not run npm");

	// And the problems setup cannot touch must be marked so, because that decides the copy.
	const byKindOld = Object.fromEntries(
		diagnose({ ...OK_PROBE, version: "3.7.9", supported: false }, true, model).map((p) => [p.kind, p.setupFixes]),
	);
	assert.equal(byKindOld.python_too_old, false, "setup cannot install an interpreter");
	assert.equal(diagnose(null, true, model)[0].setupFixes, false, "setup cannot install an interpreter");
});

test("remediation is platform-specific and never blames permissions", () => {
	const kinds = ["no_python", "python_too_old", "no_pip", "no_faster_whisper", "no_recorder"] as const;
	for (const platform of ["darwin", "win32", "linux"] as const) {
		for (const kind of kinds) {
			const cmds = remediation({ kind, summary: "s", setupFixes: false, manualCommands: [] }, platform);
			assert.ok(cmds.length > 0, `${kind} on ${platform} needs a command`);
			for (const c of cmds) {
				assert.doesNotMatch(c, /permission/i);
				assert.doesNotMatch(c, /microphone/i);
			}
		}
	}
});

test("remediation uses the platform pip spelling", () => {
	const problem = { kind: "no_faster_whisper", summary: "", setupFixes: true, manualCommands: [] } as const;
	assert.match(remediation(problem, "win32").join(" "), /py -3 -m pip install faster-whisper/);
	assert.match(remediation(problem, "darwin").join(" "), /pip3 install faster-whisper/);
	assert.match(remediation(problem, "linux").join(" "), /pip3 install faster-whisper/);
});

test("remediation for no_python uses the platform installer", () => {
	const problem = { kind: "no_python", summary: "", setupFixes: false, manualCommands: [] } as const;
	assert.match(remediation(problem, "darwin").join(" "), /brew install python|command line tools/);
	assert.match(remediation(problem, "win32").join(" "), /winget install Python/);
	assert.match(remediation(problem, "linux").join(" "), /apt install python3|distribution/);
});

test("modelCacheDir follows the Hugging Face hub layout", () => {
	assert.equal(
		modelCacheDir("base", "/home/u", undefined),
		"/home/u/.cache/huggingface/hub/models--Systran--faster-whisper-base",
	);
	assert.equal(
		modelCacheDir("small", "/home/u", "/xdg/cache"),
		"/xdg/cache/huggingface/hub/models--Systran--faster-whisper-small",
	);
});

test("modelCacheDir passes a filesystem path through unchanged", () => {
	assert.equal(modelCacheDir("/opt/models/whisper", "/home/u", undefined), "/opt/models/whisper");
	assert.equal(modelCacheDir("./local-ct2", "/home/u", undefined), "./local-ct2");
});

test("effectiveConfig adopts the interpreter the diagnosis settled on", () => {
	// Otherwise the doctor can report a healthy python3.13 while transcribe() spawns the
	// configured python3 that does not have faster-whisper.
	const cfg = { ...DEFAULT_CONFIG, python: "python3" };
	const report = {
		ready: true,
		probe: { ...OK_PROBE, command: ["python3.13"] },
		candidatesTried: ["python3", "python3.13"],
		probeNotes: [],
		problems: [],
	};
	assert.equal(effectiveConfig(cfg, report).python, "python3.13");
});

test("effectiveConfig joins multi-word launcher commands", () => {
	const report = {
		ready: true,
		probe: { ...OK_PROBE, command: ["py", "-3"] },
		candidatesTried: [], probeNotes: [], problems: [],
	};
	assert.equal(effectiveConfig({ ...DEFAULT_CONFIG, python: "python3" }, report).python, "py -3");
});

test("effectiveConfig leaves the config alone without a diagnosis or a probe", () => {
	const cfg = { ...DEFAULT_CONFIG, python: "python3" };
	assert.equal(effectiveConfig(cfg, null).python, "python3");
	assert.equal(
		effectiveConfig(cfg, { ready: false, probe: null, candidatesTried: [], probeNotes: [], problems: [] }).python,
		"python3",
	);
	// An unchanged interpreter returns the same object rather than a needless copy.
	assert.equal(effectiveConfig(cfg, null), cfg);
});
