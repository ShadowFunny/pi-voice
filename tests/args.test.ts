import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTranscribeArgs } from "../src/args.ts";

const base = {
	pcmPath: "/tmp/a.pcm",
	scriptPath: "/s/transcribe.py",
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
};

test("buildTranscribeArgs omits optional flags when they are at their defaults", () => {
	const args = buildTranscribeArgs(base);
	assert.ok(!args.includes("--language"), "auto must not be passed through as a language code");
	assert.ok(!args.includes("--no-vad"));
	assert.ok(!args.includes("--initial-prompt"));
	assert.equal(args[0], "/s/transcribe.py");
	assert.ok(args.includes("--audio") && args.includes("/tmp/a.pcm"));
	assert.equal(args[args.indexOf("--model") + 1], "base");
	assert.equal(args[args.indexOf("--sample-rate") + 1], "16000");
});

test("buildTranscribeArgs passes the script to steer, or nothing when there is none", () => {
	assert.deepEqual(
		buildTranscribeArgs({ ...base, steering: undefined }).includes("--steer-script"),
		false,
	);
	for (const steering of ["simplified", "traditional"] as const) {
		const args = buildTranscribeArgs({ ...base, steering });
		assert.equal(args[args.indexOf("--steer-script") + 1], steering);
	}
});

test("buildTranscribeArgs passes language, no-vad and an initial prompt when set", () => {
	const args = buildTranscribeArgs({
		...base,
		model: "small",
		language: "zh",
		beamSize: 5,
		computeType: "float32",
		cpuThreads: 2,
		vad: false,
		initialPrompt: "Hello, World",
	});
	const at = (flag: string) => args[args.indexOf(flag) + 1];
	assert.equal(at("--language"), "zh");
	assert.equal(at("--model"), "small");
	assert.equal(at("--beam-size"), "5");
	assert.equal(at("--compute-type"), "float32");
	assert.equal(at("--cpu-threads"), "2");
	assert.equal(at("--initial-prompt"), "Hello, World");
	assert.ok(args.includes("--no-vad"));
});
