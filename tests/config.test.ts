import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";

test("mergeConfig returns defaults for non-objects", () => {
	for (const bad of [null, undefined, 42, "x", [], true]) {
		assert.deepEqual(mergeConfig(bad), DEFAULT_CONFIG);
	}
});

test("mergeConfig fills defaults and honours valid overrides", () => {
	const merged = mergeConfig({ model: "small", language: "zh", vad: false, cpuThreads: 8, device: 2 });
	assert.equal(merged.model, "small");
	assert.equal(merged.language, "zh");
	assert.equal(merged.vad, false);
	assert.equal(merged.cpuThreads, 8);
	assert.equal(merged.device, 2);
	assert.equal(merged.beamSize, DEFAULT_CONFIG.beamSize);
	assert.equal(merged.maxSeconds, DEFAULT_CONFIG.maxSeconds);
});

test("mergeConfig rejects wrong types and keeps the default", () => {
	const merged = mergeConfig({ model: 5, vad: "yes", cpuThreads: "4", device: "1", initialPrompt: null });
	assert.equal(merged.model, DEFAULT_CONFIG.model);
	assert.equal(merged.vad, DEFAULT_CONFIG.vad);
	assert.equal(merged.cpuThreads, DEFAULT_CONFIG.cpuThreads);
	assert.equal(merged.device, DEFAULT_CONFIG.device);
	assert.equal(merged.initialPrompt, DEFAULT_CONFIG.initialPrompt);
});

test("the Chinese script is decided by language, not by a config flag", () => {
	// There is no `simplifiedChinese` switch any more: `language` alone decides the script.
	assert.ok(!("simplifiedChinese" in DEFAULT_CONFIG));

	// A stale key from an older config file is dropped like any other unknown key.
	assert.ok(!("simplifiedChinese" in mergeConfig({ simplifiedChinese: false })));
});

test("mergeConfig ignores unknown keys", () => {
	const merged = mergeConfig({ nonsense: true, __proto__: { polluted: 1 } });
	assert.ok(!("nonsense" in merged));
	assert.deepEqual(Object.keys(merged).sort(), Object.keys(DEFAULT_CONFIG).sort());
});

test("mergeConfig accepts an explicit null device and rejects negatives", () => {
	assert.equal(mergeConfig({ device: null }).device, null);
	assert.equal(mergeConfig({ device: -1 }).device, DEFAULT_CONFIG.device);
	assert.equal(mergeConfig({ device: 1.5 }).device, DEFAULT_CONFIG.device);
});

test("mergeConfig rejects non-positive numbers for numeric fields", () => {
	assert.equal(mergeConfig({ maxSeconds: 0 }).maxSeconds, DEFAULT_CONFIG.maxSeconds);
	assert.equal(mergeConfig({ sampleRate: -1 }).sampleRate, DEFAULT_CONFIG.sampleRate);
});
