import { createRequire } from "node:module";
import { createWriteStream, rmSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickDeviceIndex } from "./devices.ts";
import type { VoiceConfig } from "./config.ts";

/**
 * Samples per `read()`. PvRecorder delivers fixed-size frames, and 512 at 16 kHz is
 * 32 ms — small enough to keep latency low, large enough not to spin the event loop.
 */
const FRAME_LENGTH = 512;

/**
 * How long a stop waits for the capture loop to drain before giving up and closing the
 * file anyway. The loop only blocks on a pending `read()`, so this is a guard against a
 * wedged native call, not an expected path.
 */
const DRAIN_TIMEOUT_MS = 2000;

export interface Recording {
	pcmPath: string;
	startedAt: number;
}

export interface ActiveRecording {
	/** Destination of the raw PCM, available while recording. */
	readonly pcmPath: string;
	/** Idempotent. Stops the device and returns the PCM path. */
	stop(): Promise<Recording>;
	/** Stops and deletes the recording. */
	abort(): Promise<void>;
	readonly elapsedMs: number;
	/** Resolves once recording has ended, including via the maxSeconds cap. */
	readonly ended: Promise<void>;
}

interface PvRecorderInstance {
	start(): void;
	stop(): void;
	release(): void;
	read(): Promise<Int16Array>;
	getSelectedDevice(): string;
}

interface PvRecorderModule {
	PvRecorder: {
		new (frameLength: number, deviceIndex?: number): PvRecorderInstance;
		getAvailableDevices(): string[];
	};
}

const require_ = createRequire(import.meta.url);

/**
 * Load the bundled recorder.
 *
 * The package ships prebuilt binaries for every target it supports — including
 * `lib/mac/x86_64`, the Intel-Mac build that other capture libraries lack — so there is no
 * compile step and no external tool.
 */
function loadPvRecorder(): PvRecorderModule {
	try {
		return require_("@picovoice/pvrecorder-node") as PvRecorderModule;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`pvrecorder is unavailable (${detail}). Run "npm install" in the pi-voice project directory.`,
		);
	}
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function listDevices(): Promise<string[]> {
	return loadPvRecorder().PvRecorder.getAvailableDevices();
}

export async function resolveDevice(configured: number | null): Promise<number> {
	return pickDeviceIndex(await listDevices(), configured);
}

export async function startRecording(cfg: VoiceConfig): Promise<ActiveRecording> {
	const { PvRecorder } = loadPvRecorder();
	const deviceIndex = await resolveDevice(cfg.device);

	// Selecting before constructing keeps an invalid index from surfacing as an opaque
	// native init failure.
	const selectedName = (await listDevices())[deviceIndex] ?? "";

	const startedAt = Date.now();
	const pcmPath = join(tmpdir(), `pi-voice-${process.pid}-${startedAt}.pcm`);
	const stream: WriteStream = createWriteStream(pcmPath);
	const recorder = new PvRecorder(FRAME_LENGTH, deviceIndex);
	recorder.start();

	let stopping = false;
	let samples = 0;
	let finalizePromise: Promise<void> | null = null;
	let markEnded: () => void = () => {};
	const ended = new Promise<void>((resolve) => { markEnded = resolve; });

	const closeStream = () =>
		new Promise<void>((resolve) => {
			if (stream.closed || stream.destroyed) {
				resolve();
				return;
			}
			stream.end(() => resolve());
		});

	/** Idempotent teardown: stop the device, flush the file, signal `ended`. */
	const finalize = (): Promise<void> => {
		if (!finalizePromise) {
			finalizePromise = (async () => {
				stopping = true;
				try { recorder.stop(); } catch { /* already stopped */ }
				try { recorder.release(); } catch { /* already released */ }
				await closeStream();
				markEnded();
			})();
		}
		return finalizePromise;
	};

	const maxSamples = cfg.maxSeconds > 0 ? cfg.maxSeconds * cfg.sampleRate : Number.POSITIVE_INFINITY;

	// Capture loop. Frames are appended to the file as they arrive rather than assembled
	// at the end, so an interrupted recording keeps everything already captured.
	void (async () => {
		try {
			while (!stopping) {
				const frame = await recorder.read();
				if (stopping) break;

				const chunk = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
				if (!stream.write(chunk)) {
					await new Promise<void>((resolve) => stream.once("drain", resolve));
				}

				samples += frame.length;
				if (samples >= maxSamples) break;
			}
		} catch {
			// `read()` rejects once the device is released; that is the normal way this
			// loop ends, so it is not an error worth reporting.
		}
		await finalize();
	})();

	const stop = async (): Promise<Recording> => {
		if (stopping && finalizePromise) {
			await finalizePromise;
			return { pcmPath, startedAt };
		}
		// Always run teardown; the loop may be parked on a pending read().
		await Promise.race([finalize(), delay(DRAIN_TIMEOUT_MS)]);
		await finalizePromise;
		return { pcmPath, startedAt };
	};

	return {
		pcmPath,
		get elapsedMs() {
			return Date.now() - startedAt;
		},
		ended,
		stop,
		async abort() {
			await stop();
			try {
				rmSync(pcmPath, { force: true });
			} catch {
				// Best effort.
			}
		},
	};
}
