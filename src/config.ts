import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface VoiceConfig {
	/** faster-whisper model name or local path. */
	model: string;
	/**
	 * "auto" lets Whisper detect per utterance; otherwise a language code. The code also picks
	 * the script Chinese output is steered to — see planLanguage.
	 */
	language: string;
	/** PvRecorder input index, or null to auto-select at record time. */
	device: number | null;
	python: string;
	computeType: string;
	cpuThreads: number;
	beamSize: number;
	vad: boolean;
	maxSeconds: number;
	sampleRate: number;
	initialPrompt: string;
}

export const DEFAULT_CONFIG: VoiceConfig = {
	model: "base",
	language: "auto",
	device: null,
	python: "python3",
	computeType: "int8",
	cpuThreads: 4,
	beamSize: 1,
	vad: true,
	maxSeconds: 120,
	sampleRate: 16000,
	initialPrompt: "",
};

export function configPath(): string {
	const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
	return join(base, "pi-voice", "config.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Field-by-field validation. Unknown keys are dropped, wrong types fall back to
 * the default per field, and nothing throws.
 *
 * Dictation must not break because of a typo in a config file, so a malformed
 * value degrades one setting instead of failing the whole load.
 */
export function mergeConfig(raw: unknown): VoiceConfig {
	const out: VoiceConfig = { ...DEFAULT_CONFIG };
	if (!isPlainObject(raw)) return out;

	const target = out as unknown as Record<string, unknown>;
	for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
		if (!Object.hasOwn(raw, key)) continue;
		const value = raw[key];

		if (key === "device") {
			if (value === null) target[key] = null;
			else if (typeof value === "number" && Number.isInteger(value) && value >= 0) target[key] = value;
			continue;
		}

		if (typeof fallback === "number") {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) target[key] = value;
		} else if (typeof fallback === "boolean") {
			if (typeof value === "boolean") target[key] = value;
		} else if (typeof value === "string") {
			target[key] = value;
		}
	}

	return out;
}

export function loadConfig(): VoiceConfig {
	try {
		return mergeConfig(JSON.parse(readFileSync(configPath(), "utf-8")));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Best-effort persist; a read-only config directory must not break dictation. */
export function saveConfig(patch: Partial<VoiceConfig>): VoiceConfig {
	const next = mergeConfig({ ...loadConfig(), ...patch });
	try {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
	} catch {
		// Intentionally ignored: the caller reports the effective config either way.
	}
	return next;
}
