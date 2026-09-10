/**
 * Input selection for PvRecorder.
 *
 * PvRecorder reports inputs as an ordered list of names, so selecting a device is a pure
 * list operation. This is kept separate from the recording code so it can be tested
 * without a microphone.
 */

/**
 * Substrings tried in order. "built-in microphone" must be tested before the generic
 * "microphone" so an internal mic wins over a USB one, and "mic" is deliberately last
 * because it also appears in device names like "Microphone Speaker Array".
 */
const PREFERRED_SUBSTRINGS = ["built-in microphone", "built-in mic", "microphone"];

/**
 * Resolve the device index to record from.
 *
 * Throws instead of returning a fallback when the request cannot be satisfied: silently
 * recording from a different microphone than the one asked for is worse than an error,
 * because the user cannot tell it happened.
 */
export function pickDeviceIndex(names: string[], configured: number | null): number {
	if (names.length === 0) {
		throw new Error("No microphone found. Run /voice devices to list inputs.");
	}

	if (configured !== null) {
		const valid = Number.isInteger(configured) && configured >= 0 && configured < names.length;
		if (!valid) {
			throw new Error(
				`Microphone index ${configured} is out of range: ${names.length} input(s) available. Run /voice devices.`,
			);
		}
		return configured;
	}

	for (const needle of PREFERRED_SUBSTRINGS) {
		const index = names.findIndex((name) => name.toLowerCase().includes(needle));
		if (index >= 0) return index;
	}

	// Nothing identified itself as a microphone; take the first input rather than
	// refusing to record at all.
	return 0;
}
