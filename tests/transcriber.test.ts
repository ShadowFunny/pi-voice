import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TranscribeError, describeFailure, scriptPath, transcribe } from "../src/transcriber.ts";

const here = dirname(fileURLToPath(import.meta.url));

function has(bin: string): boolean {
	return spawnSync("which", [bin], { encoding: "utf-8" }).status === 0;
}

const canRun = has("python3");
const skip = canRun ? false : "needs python3";

test("scriptPath points at the shipped python script", () => {
	assert.ok(existsSync(scriptPath()), `missing ${scriptPath()}`);
	assert.ok(scriptPath().endsWith("transcribe.py"));
});

test("a missing python binary reports python_missing", async () => {
	await assert.rejects(
		transcribe("/tmp/whatever.pcm", { ...DEFAULT_CONFIG, python: "definitely-not-a-binary-xyz" }),
		(err: unknown) => {
			assert.ok(err instanceof TranscribeError);
			assert.equal(err.kind, "python_missing");
			return true;
		},
	);
});

test("a non-zero exit without a JSON error reports python_failed", async () => {
	await assert.rejects(
		transcribe("/tmp/whatever.pcm", { ...DEFAULT_CONFIG, python: "false" }),
		(err: unknown) => err instanceof TranscribeError && err.kind === "python_failed",
	);
});

test("stdout that is not JSON reports protocol", async () => {
	// `echo` exits 0 and prints the argv it was handed, which is never JSON.
	await assert.rejects(
		transcribe("/tmp/whatever.pcm", { ...DEFAULT_CONFIG, python: "echo" }),
		(err: unknown) => err instanceof TranscribeError && err.kind === "protocol",
	);
});

test("a missing audio file reports audio_unreadable", { skip }, async () => {
	await assert.rejects(transcribe("/nonexistent/x.pcm", DEFAULT_CONFIG), (err: unknown) => {
		assert.ok(err instanceof TranscribeError);
		assert.equal(err.kind, "audio_unreadable");
		return true;
	});
});

test("transcribes a real recording through the wrapper", { skip }, async () => {
	const result = await transcribe(join(here, "fixtures", "en.pcm"), DEFAULT_CONFIG);
	assert.match(result.text.toLowerCase(), /transcribe/);
	assert.ok(result.elapsedSeconds >= 0);
	assert.equal(typeof result.languageProbability, "number");
});

test("the wrapper reports which script it steered", { skip }, async () => {
	const zh = join(here, "fixtures", "zh.pcm");

	// `auto` and plain `zh` both mean Simplified for Chinese audio.
	const steered = await transcribe(zh, DEFAULT_CONFIG);
	assert.equal(steered.scriptSteering, "simplified");

	// A Traditional language code is the user asking for that script instead.
	const traditional = await transcribe(zh, { ...DEFAULT_CONFIG, language: "zh-TW" });
	assert.equal(traditional.scriptSteering, "traditional");

	// Steering off leaves Whisper's own script alone.
	const off = await transcribe(zh, { ...DEFAULT_CONFIG, simplifiedChinese: false });
	assert.equal(off.scriptSteering, null);

	// The default is on, so an English recording is the case that proves the prompt is not
	// applied globally.
	const plain = await transcribe(join(here, "fixtures", "en.pcm"), DEFAULT_CONFIG);
	assert.equal(plain.scriptSteering, null);
});

test("aborting a transcription kills the child and reports cancelled", { skip }, async () => {
	const controller = new AbortController();
	const started = Date.now();
	const promise = transcribe(join(here, "fixtures", "en.pcm"), DEFAULT_CONFIG, {
		signal: controller.signal,
	});

	// Long enough that spawn has certainly happened; the full transcription takes seconds.
	setTimeout(() => controller.abort(), 200);

	await assert.rejects(promise, (err: unknown) => {
		assert.ok(err instanceof TranscribeError, `expected a TranscribeError, got ${String(err)}`);
		assert.equal(err.kind, "cancelled");
		return true;
	});

	// A cancelled run must not wait for the model: if the child survived, this would be
	// the full inference time instead.
	assert.ok(Date.now() - started < 4000, "abort should not wait for the transcription to finish");
});

test("an already-aborted signal fails without starting work", { skip }, async () => {
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		transcribe(join(here, "fixtures", "en.pcm"), DEFAULT_CONFIG, { signal: controller.signal }),
		(err: unknown) => {
			assert.ok(err instanceof TranscribeError);
			assert.equal(err.kind, "cancelled");
			return true;
		},
	);
});

test("describeFailure names the real cause and never blames permissions", () => {
	assert.match(describeFailure(new TranscribeError("no_faster_whisper", "x")), /faster-whisper is not installed/);
	assert.match(describeFailure(new TranscribeError("python_missing", "x")), /python3 not found/);
	assert.match(describeFailure(new TranscribeError("model_unavailable", "boom")), /boom/);
	assert.match(describeFailure(new TranscribeError("audio_unreadable", "/p")), /\/p/);

	const kinds = ["no_faster_whisper", "python_missing", "model_unavailable",
		"audio_unreadable", "python_failed", "protocol", "cancelled"] as const;
	for (const kind of kinds) {
		const text = describeFailure(new TranscribeError(kind, "detail"));
		assert.ok(text.length > 0, `${kind} must have copy`);
		assert.doesNotMatch(text, /Microphone unavailable/);
		assert.doesNotMatch(text, /permission/i);
	}
});
