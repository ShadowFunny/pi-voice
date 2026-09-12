import { test } from "node:test";
import assert from "node:assert/strict";
import { planLanguage } from "../src/language.ts";

test("planLanguage sends zh script subtags to Whisper as plain zh", () => {
	// Whisper's language list has no script subtags: `zh-Hant` is rejected outright. The script
	// is expressed through the prompt instead, so the code handed over is always `zh`.
	for (const code of ["zh", "zh-Hans", "zh-CN", "zh-SG", "zh-Hant", "zh-TW", "zh-HK", "zh-MO"]) {
		assert.equal(planLanguage(code).whisper, "zh", `${code} should be sent as zh`);
	}
});

test("planLanguage steers Simplified for zh, zh-Hans, zh-CN and auto", () => {
	for (const code of ["auto", "zh", "zh-Hans", "zh-CN", "zh-SG", "ZH-hans"]) {
		assert.equal(planLanguage(code).steering, "simplified", `${code} should steer Simplified`);
	}
});

test("planLanguage steers Traditional when the language asks for it", () => {
	// An explicit Traditional variant outranks the Simplified default: it is the user saying
	// which script they want.
	for (const code of ["zh-Hant", "zh-TW", "zh-HK", "zh-MO", "ZH-hant"]) {
		assert.equal(planLanguage(code).steering, "traditional", `${code} should steer Traditional`);
	}
});

test("planLanguage leaves every other language alone", () => {
	// Shared by English and by the codes Whisper still rejects: the extension must not turn a
	// typo into a silently different language, and non-Chinese audio must never be steered.
	for (const code of ["en", "ja", "yue", "en-US", "zh_CN", "chinese", "zh-Hans-CN"]) {
		const plan = planLanguage(code);
		assert.equal(plan.whisper, code, `${code} should pass through untouched`);
		assert.equal(plan.steering, undefined, `${code} must not be steered`);
	}
});

test("planLanguage treats an empty or padded value as auto", () => {
	for (const code of ["", "  ", " auto ", "AUTO"]) {
		const plan = planLanguage(code);
		assert.equal(plan.whisper, "auto");
		assert.equal(plan.steering, "simplified");
	}
});
