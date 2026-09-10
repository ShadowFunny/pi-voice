import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "../src/setup.ts";

test("runSetup stops with instructions when no interpreter exists", async () => {
	const venv = join(tmpdir(), "pvfw-never-created-xyz");
	const stages: string[] = [];
	const result = await runSetup({
		candidates: [{ command: ["definitely-not-a-real-binary-xyz"], label: "nope" }],
		venvDir: venv,
		onProgress: (stage) => stages.push(stage),
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "no_python");
	assert.ok(result.commands.length > 0, "must print how to install Python");
	assert.match(result.commands.join(" "), /python/i);
	assert.ok(!existsSync(venv), "must not create a venv it cannot populate");
});

test("runSetup skips an interpreter that is too old", async () => {
	// `false` runs successfully but prints nothing, so it cannot be probed into a version.
	const result = await runSetup({
		candidates: [{ command: ["false"], label: "false" }],
		venvDir: join(tmpdir(), "pvfw-never-created-abc"),
		onProgress: () => {},
	});
	assert.equal(result.ok, false);
	assert.equal(result.reason, "no_python");
});

test("runSetup creates a venv and installs faster-whisper", {
	skip: process.env.PVFW_SETUP_TEST !== "1" ? "set PVFW_SETUP_TEST=1 (downloads ~200MB)" : false,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pvfw-setup-"));
	const venv = join(dir, "venv");
	try {
		const stages: string[] = [];
		const result = await runSetup({
			candidates: [{ command: ["python3"], label: "python3" }],
			venvDir: venv,
			onProgress: (stage) => stages.push(stage),
		});

		assert.equal(result.ok, true, `setup failed (${result.reason}): ${result.detail}`);
		assert.ok(existsSync(result.python), `expected an interpreter at ${result.python}`);
		assert.ok(result.python.startsWith(venv), "the interpreter must be the venv's own");
		assert.ok(stages.includes("venv"), `expected a venv stage, got ${stages.join(",")}`);
		assert.ok(stages.includes("install"), `expected an install stage, got ${stages.join(",")}`);
		assert.ok(stages.includes("verify"), `expected a verify stage, got ${stages.join(",")}`);
		assert.ok((result.detail ?? "").length > 0, "should report the installed version");

		// Idempotent: running it again over the same venv must succeed, because re-running
		// setup is the documented fix for a broken environment.
		const again = await runSetup({
			candidates: [{ command: ["python3"], label: "python3" }],
			venvDir: venv,
			onProgress: () => {},
		});
		assert.equal(again.ok, true, `second run failed: ${again.detail}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
