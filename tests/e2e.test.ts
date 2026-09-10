import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTranscribeArgs, type TranscribeOptions } from "../src/args.ts";
import { planLanguage } from "../src/language.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "python", "transcribe.py");
const FIXTURES = join(here, "fixtures");

/**
 * Fixtures are committed 16 kHz mono s16le PCM, so this suite runs on any platform
 * without needing `say` (macOS only) or `ffmpeg` to build them.
 */
function fixture(name: string): string {
	return join(FIXTURES, name);
}

function runTranscribe(pcmPath: string, overrides: Partial<TranscribeOptions> = {}) {
	const args = buildTranscribeArgs({
		pcmPath,
		scriptPath: SCRIPT,
		python: "python3",
		model: "base",
		language: "auto",
		beamSize: 1,
		computeType: "int8",
		cpuThreads: 4,
		vad: true,
		initialPrompt: "",
		sampleRate: 16000,
		steering: undefined,
		...overrides,
	});
	return spawnSync("python3", args, { encoding: "utf-8", timeout: 300_000 });
}

function withTempDir(fn: (dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "pvfw-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const hasPython = spawnSync("which", ["python3"], { encoding: "utf-8" }).status === 0;
const skip = hasPython ? false : "needs python3";

/**
 * The committed 16 kHz mono s16le PCM fixtures: one English, one Chinese.
 *
 * Both are real speech and the transcriber assertions below depend on their exact words, so
 * they must not be regenerated or replaced without updating those assertions.
 */
const EN_FIXTURE = "en.pcm";
const ZH_FIXTURE = "zh.pcm";

test("the committed fixtures are the expected format", () => {
	for (const name of [EN_FIXTURE, ZH_FIXTURE]) {
		const bytes = statSync(fixture(name)).size;
		assert.equal(bytes % 2, 0, `${name} should be whole 16-bit samples`);
		const seconds = bytes / 2 / 16000;
		assert.ok(seconds > 1 && seconds < 15, `${name} is ${seconds}s, expected 1-15s of speech`);
	}
});

test("transcribes real English speech end to end", { skip }, () => {
	const { status, stdout } = runTranscribe(fixture(EN_FIXTURE));
	assert.equal(status, 0, `non-zero exit: ${stdout}`);
	const result = JSON.parse(stdout);
	assert.match(result.text.toLowerCase(), /transcribe/);
	assert.match(result.text.toLowerCase(), /quick brown fox/);
	assert.equal(result.language, "en");
	assert.ok(result.durationSeconds > 5, "duration should reflect the audio length");
	assert.ok(Array.isArray(result.segments));
});

test("transcribes real Chinese speech end to end", { skip }, () => {
	// Covers the CJK path: auto language detection landing on zh and the model producing
	// characters rather than an empty string.
	const { status, stdout } = runTranscribe(fixture(ZH_FIXTURE));
	assert.equal(status, 0, `non-zero exit: ${stdout}`);
	const result = JSON.parse(stdout);
	assert.equal(result.language, "zh");
	assert.match(result.text, /[\u4e00-\u9fff]{2,}/, "expected CJK characters in the transcript");
});

test("a Simplified steering prompt reaches the model and moves the script", { skip }, () => {
	// Mandarin output is unstable: this same fixture transcribes to Traditional characters when
	// nothing steers it, which is what makes it usable for this.
	const zh = JSON.parse(runTranscribe(fixture(ZH_FIXTURE), { steering: "simplified" }).stdout);
	assert.equal(zh.language, "zh");
	assert.equal(zh.scriptSteering, "simplified");
	assert.match(zh.text, /天气/);
	assert.match(zh.text, /我们/);
	assert.doesNotMatch(zh.text, /[們說裡檔發學國氣]/, `still Traditional: ${zh.text}`);
});

test("the steering prompt never reaches a non-Chinese recording", { skip }, () => {
	const en = JSON.parse(runTranscribe(fixture(EN_FIXTURE), { steering: "simplified" }).stdout);
	assert.equal(en.language, "en");
	assert.equal(en.scriptSteering, null, "a non-Chinese recording must not be steered");
	assert.match(en.text.toLowerCase(), /quick brown fox/);
});

test("a Traditional language code runs the Traditional prompt instead", { skip }, () => {
	// The whole path for `language: "zh-TW"`: a script subtag becomes a Whisper code plus the
	// script to steer.
	const plan = planLanguage("zh-TW", true);
	const result = JSON.parse(runTranscribe(fixture(ZH_FIXTURE), {
		language: plan.whisper,
		steering: plan.steering,
	}).stdout);
	assert.equal(plan.whisper, "zh");
	assert.equal(result.scriptSteering, "traditional");
	assert.match(result.text, /[氣們寫碼]/, `expected Traditional characters: ${result.text}`);
	assert.doesNotMatch(result.text, /[气们写码]/, `expected no Simplified characters: ${result.text}`);
});

test("without steering the Chinese transcript is whatever Whisper chose", { skip }, () => {
	const result = JSON.parse(runTranscribe(fixture(ZH_FIXTURE), { steering: undefined }).stdout);
	assert.equal(result.language, "zh");
	assert.equal(result.scriptSteering, null);
	assert.match(result.text, /[\u4e00-\u9fff]{2,}/);
});

test("steering keeps the user's own initial prompt", { skip }, () => {
	// An explicit language skips detection entirely, which is the other steering path.
	const result = JSON.parse(runTranscribe(fixture(ZH_FIXTURE), {
		steering: "simplified",
		language: "zh",
		initialPrompt: "Hello, World",
	}).stdout);
	assert.equal(result.language, "zh");
	assert.equal(result.scriptSteering, "simplified");
	assert.doesNotMatch(result.text, /[們說裡檔發學國氣]/, `still Traditional: ${result.text}`);
});

test("stdout is a single parseable JSON object with nothing else", { skip }, () => {
	const { stdout } = runTranscribe(fixture(EN_FIXTURE));
	const parsed = JSON.parse(stdout);
	assert.ok(!("error" in parsed));
	assert.equal(stdout.trim().split("\n").length, 1, "stdout must be exactly one line");
});

test("pure silence produces empty text rather than a hallucination", { skip }, () => {
	withTempDir((dir) => {
		// Generated in JS — no ffmpeg needed to make three seconds of silence.
		const pcm = join(dir, "silence.pcm");
		writeFileSync(pcm, Buffer.alloc(16000 * 3 * 2));

		const { status, stdout } = runTranscribe(pcm);
		assert.equal(status, 0, `non-zero exit: ${stdout}`);
		assert.equal(JSON.parse(stdout).text, "");
	});
});

test("an empty recording reports empty text instead of failing", { skip }, () => {
	withTempDir((dir) => {
		const pcm = join(dir, "empty.pcm");
		writeFileSync(pcm, Buffer.alloc(0));
		const { status, stdout } = runTranscribe(pcm);
		assert.equal(status, 0, `non-zero exit: ${stdout}`);
		const parsed = JSON.parse(stdout);
		assert.equal(parsed.text, "");
		assert.equal(parsed.durationSeconds, 0);
	});
});

test("a missing audio file reports audio_unreadable, not a crash", { skip }, () => {
	const { status, stdout } = runTranscribe("/nonexistent/nope.pcm");
	assert.notEqual(status, 0);
	assert.equal(JSON.parse(stdout).error.kind, "audio_unreadable");
});

test("the fixtures are not silent", () => {
	// Guards the fixtures themselves: a silently-empty file would let the transcription
	// assertions pass for the wrong reason on a model that returns "" for silence.
	for (const name of [EN_FIXTURE, ZH_FIXTURE]) {
		const buf = readFileSync(fixture(name));
		let peak = 0;
		for (let i = 0; i + 1 < buf.length; i += 2) {
			const v = Math.abs(buf.readInt16LE(i));
			if (v > peak) peak = v;
		}
		assert.ok(peak > 1000, `${name} peak ${peak} is suspiciously quiet`);
	}
});
