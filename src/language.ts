/**
 * Language and script policy.
 *
 * Whisper's language list has no script subtags — `zh-Hans` and `zh-TW` are rejected by
 * `faster-whisper` — and its Chinese output has no stable script either: the same speaker can
 * come back Traditional or Simplified. So the script is not something the language code can
 * express, and it is expressed through the decoder prompt instead.
 */

/** Which script to steer Chinese output to. */
export type ScriptSteering = "simplified" | "traditional";

export interface LanguagePlan {
	/** The code to hand to `faster-whisper`; `auto` means let Whisper detect it. */
	whisper: string;
	/** The script to steer Chinese output to, or undefined for a language that is not Chinese. */
	steering: ScriptSteering | undefined;
}

/** Script subtags and regions, mapped to the script they imply. */
const SIMPLIFIED_TAGS = new Set(["hans", "cn", "sg"]);
const TRADITIONAL_TAGS = new Set(["hant", "tw", "hk", "mo"]);

/**
 * Resolve what to send to the transcriber and which script to steer, from the language alone.
 *
 * `auto` and plain `zh` both steer Simplified, because a Chinese transcript that comes back
 * Traditional is not what most dictation wants. A language code that names a Traditional
 * region or script outranks that default: it is the user asking for that script. Every other
 * language resolves to no steering, so nothing is injected for non-Chinese audio — and in
 * `auto` mode the steering is only applied once the audio has actually been detected as
 * Chinese.
 */
export function planLanguage(language: string): LanguagePlan {
	const code = language.trim();
	const lowered = code.toLowerCase();

	if (lowered === "" || lowered === "auto") {
		return { whisper: "auto", steering: "simplified" };
	}

	const match = /^zh-([a-z]+)$/.exec(lowered);
	if (lowered === "zh" || match) {
		const subtag = match?.[1];
		// An unrecognised zh subcode is a typo, and Whisper's own error names it better than a
		// guess would, so it is passed through to be rejected there.
		if (subtag !== undefined && !SIMPLIFIED_TAGS.has(subtag) && !TRADITIONAL_TAGS.has(subtag)) {
			return { whisper: code, steering: undefined };
		}

		const script = subtag !== undefined && TRADITIONAL_TAGS.has(subtag) ? "traditional" : "simplified";
		return { whisper: "zh", steering: script };
	}

	// Every other language: passed through untouched, script untouched.
	return { whisper: code, steering: undefined };
}
