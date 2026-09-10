export interface TranscribeOptions {
	pcmPath: string;
	scriptPath: string;
	python: string;
	model: string;
	language: string;
	beamSize: number;
	computeType: string;
	cpuThreads: number;
	vad: boolean;
	initialPrompt: string;
	sampleRate: number;
	/** Resolved by planLanguage: which script to steer Chinese output to, if any. */
	steering: ScriptSteering | undefined;
}

export function buildTranscribeArgs(o: TranscribeOptions): string[] {
	const args = [
		o.scriptPath,
		"--audio", o.pcmPath,
		"--model", o.model,
		"--sample-rate", String(o.sampleRate),
		"--beam-size", String(o.beamSize),
		"--compute-type", o.computeType,
		"--cpu-threads", String(o.cpuThreads),
	];
	if (o.language !== "auto") args.push("--language", o.language);
	if (!o.vad) args.push("--no-vad");
	if (o.initialPrompt) args.push("--initial-prompt", o.initialPrompt);
	if (o.steering) args.push("--steer-script", o.steering);
	return args;
}
