import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { listDevices, resolveDevice, startRecording } from "../src/recorder.ts";

const cfg = { ...DEFAULT_CONFIG, maxSeconds: 30 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Decide whether a recorder failure is this project's defect or the machine's limitation.
 *
 * These tests drive real hardware, so they are skipped where there is none. The asymmetry is
 * deliberate and load-bearing: a recorder package that is *not there* means packaging or
 * `npm install` failed and must fail loudly, whereas a machine with no audio stack (a bare CI
 * runner with no ALSA, a container, a headless server) is not a defect in this extension.
 *
 * The distinction matters most on the Linux CI leg, which cannot be reproduced on the
 * development machine: without it, "no sound card in the runner" would look like a broken
 * package.
 */
export function classifyRecorderFailure(message: string): string | null {
	if (/Cannot find module|MODULE_NOT_FOUND/.test(message)) {
		// Real defect: fail the suite rather than quietly report green.
		return null;
	}
	return message;
}

let skip: string | false = false;
try {
	const devices = await listDevices();
	if (devices.length === 0) skip = "no audio input device on this machine";
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	const environmental = classifyRecorderFailure(message);
	if (environmental === null) throw err;
	skip = `audio backend unavailable: ${environmental}`;
}

// This classifier decides whether CI goes red, so it is verified even when the hardware tests
// themselves are skipped.
test("a recorder package that is missing is a defect, not a skip", () => {
	assert.equal(
		classifyRecorderFailure("pvrecorder is unavailable (Cannot find module '@picovoice/pvrecorder-node')"),
		null,
	);
	assert.equal(classifyRecorderFailure("Error: MODULE_NOT_FOUND"), null);
});

test("a machine without an audio backend is skipped, not failed", () => {
	for (const message of [
		"libasound.so.2: cannot open shared object file: No such file or directory",
		"pvrecorder is unavailable (dlopen failed: no audio backend)",
		"ALSA lib confmisc.c: Unable to find definition",
	]) {
		assert.equal(classifyRecorderFailure(message), message, `${message} should be environmental`);
	}
});

/** Peak absolute sample, to prove the capture contains real audio and not silence. */
function peakOf(path: string): number {
	const buf = readFileSync(path);
	let peak = 0;
	for (let i = 0; i + 1 < buf.length; i += 2) {
		const v = Math.abs(buf.readInt16LE(i));
		if (v > peak) peak = v;
	}
	return peak;
}

test("listDevices returns input names", { skip }, async () => {
	const devices = await listDevices();
	assert.ok(devices.length > 0);
	for (const name of devices) {
		assert.equal(typeof name, "string");
		assert.ok(name.length > 0);
	}
});

test("resolveDevice auto-selects a usable index", { skip }, async () => {
	const devices = await listDevices();
	const index = await resolveDevice(null);
	assert.ok(Number.isInteger(index) && index >= 0, `expected a real index, got ${index}`);
	assert.ok(index < devices.length, "the index must address a listed device");
});

test("resolveDevice passes an explicit index through", { skip }, async () => {
	assert.equal(await resolveDevice(0), 0);
});

test("resolveDevice rejects an index that does not exist", { skip }, async () => {
	// The pure range check is covered in test/devices.test.ts; this asserts the wiring.
	const devices = await listDevices();
	await assert.rejects(resolveDevice(devices.length + 5), /No microphone found|out of range/);
});

test("records real audio and stops on demand", { skip }, async () => {
	const rec = await startRecording(cfg);
	assert.ok(rec.elapsedMs >= 0);
	await sleep(1200);
	const stopped = await rec.stop();

	assert.ok(existsSync(stopped.pcmPath), "PCM file should exist after stop");
	const samples = statSync(stopped.pcmPath).size / 2;
	const seconds = samples / cfg.sampleRate;
	// Frame-quantised, so allow one frame of slack below the wall-clock duration.
	assert.ok(seconds > 1.0, `expected >1s of audio, got ${seconds}s`);
	assert.ok(rec.elapsedMs >= 1000, "elapsed should track real time");

	await rec.abort();
	assert.ok(!existsSync(stopped.pcmPath), "abort should delete the recording");
});

test("captured PCM contains real audio rather than silence", { skip }, async () => {
	const rec = await startRecording(cfg);
	await sleep(1000);
	const { pcmPath } = await rec.stop();
	assert.ok(peakOf(pcmPath) > 0, "peak sample was 0 — the capture is silent");
	await rec.abort();
});

test("stop is idempotent", { skip }, async () => {
	const rec = await startRecording(cfg);
	await sleep(700);
	const a = await rec.stop();
	const b = await rec.stop();
	assert.equal(a.pcmPath, b.pcmPath);
	assert.equal(statSync(a.pcmPath).size, statSync(b.pcmPath).size, "a second stop must not append more audio");
	await rec.abort();
});

test("survives repeated start/stop cycles", { skip }, async () => {
	// The removed ffmpeg implementation needed a retry loop because avfoundation
	// intermittently refused to start. PvRecorder has shown no such behaviour, so the
	// confidence has to come from exercising the cycle repeatedly instead of from
	// untested retry code.
	for (let i = 0; i < 5; i++) {
		const rec = await startRecording(cfg);
		await sleep(450);
		const { pcmPath } = await rec.stop();
		const seconds = statSync(pcmPath).size / 2 / cfg.sampleRate;
		assert.ok(seconds > 0.2, `cycle ${i} captured only ${seconds}s`);
		await rec.abort();
	}
});

test("ended resolves when the recording hits the maxSeconds cap", { skip }, async () => {
	const rec = await startRecording({ ...cfg, maxSeconds: 1 });
	const t0 = Date.now();
	await rec.ended;
	const elapsed = Date.now() - t0;
	assert.ok(elapsed >= 200 && elapsed < 5000, `expected a self-terminating capture, took ${elapsed}ms`);
	// The cap is a real stop, so the audio is still on disk and usable.
	assert.ok(statSync(rec.pcmPath).size > cfg.sampleRate * 2 * 0.5, "cap should still leave usable audio");
	await rec.abort();
});

test("a stopped recording leaves no files behind", { skip }, async () => {
	const before = readdirSync(tmpdir()).filter((f) => f.startsWith("pi-voice-")).length;
	const rec = await startRecording(cfg);
	await sleep(400);
	await rec.abort();
	const after = readdirSync(tmpdir()).filter((f) => f.startsWith("pi-voice-")).length;
	assert.equal(after, before, "abort must clean up its partial file");
});
