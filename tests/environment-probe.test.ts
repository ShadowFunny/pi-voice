import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { checkModelCached, probePython, runDiagnosis } from "../src/environment.ts";

test("probePython reports the version of a real interpreter", async () => {
	const outcome = await probePython({ command: ["python3"], label: "python3" });
	assert.ok(outcome.ok, `expected a probe, got ${JSON.stringify(outcome)}`);
	assert.match(outcome.probe.version ?? "", /^\d+\.\d+\.\d+$/);
	assert.equal(outcome.probe.supported, true);
	assert.equal(outcome.probe.command.join(" "), "python3");
});

test("probePython reports not_found for a command that does not exist", async () => {
	const outcome = await probePython({ command: ["definitely-not-a-real-binary-xyz"], label: "nope" });
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.equal(outcome.reason, "not_found");
});

test("probePython reports not_found rather than throwing for a non-executable path", async () => {
	const outcome = await probePython({ command: ["/etc/hosts"], label: "/etc/hosts" });
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.equal(outcome.reason, "not_found");
});

test("probePython reports timeout when the interpreter is too slow to answer", async () => {
	// A 1ms budget guarantees the deadline fires, which is what a wedged interpreter looks
	// like — the case that produced a misleading "could not be run" message in practice.
	const outcome = await probePython({ command: ["python3"], label: "python3" }, 1);
	assert.equal(outcome.ok, false);
	if (!outcome.ok) {
		assert.equal(outcome.reason, "timeout");
		assert.match(outcome.detail, /within/);
	}
});

test("runDiagnosis finds a working interpreter on this machine", async () => {
	const report = await runDiagnosis(DEFAULT_CONFIG);
	assert.ok(report.candidatesTried.length > 0, "should report what it tried");
	assert.ok(report.probe, `expected a usable python; tried ${report.candidatesTried.join(", ")}`);
	assert.equal(report.probe.hasFasterWhisper, true, "faster-whisper is installed on this machine");
	assert.equal(report.ready, true, `unexpected problems: ${JSON.stringify(report.problems)}`);
});

test("runDiagnosis falls back to a real candidate when the configured one is broken", async () => {
	// The configured interpreter is preferred, but a stale config must not be a dead end.
	const report = await runDiagnosis({ ...DEFAULT_CONFIG, python: "definitely-not-a-real-binary-xyz" });
	assert.ok(report.probe, "should have fallen back to a real interpreter");
	assert.ok(report.candidatesTried[0].includes("definitely-not-a-real-binary-xyz"), "should try the configured one first");
});

test("checkModelCached is true for the cached base model and false for a nonsense id", () => {
	assert.equal(checkModelCached("base"), true, "base is cached on this machine");
	assert.equal(checkModelCached("model-that-does-not-exist-xyz"), false);
});

test("checkModelCached treats a local path by its existence", () => {
	const dir = mkdtempSync(join(tmpdir(), "pvfw-env-"));
	try {
		assert.equal(checkModelCached(join(dir, "nope")), false);
		mkdirSync(join(dir, "model"));
		assert.equal(checkModelCached(join(dir, "model")), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
