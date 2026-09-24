import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HOME = homedir();
const WHISPER_CLI = process.env.PI_TELEGRAM_WHISPER_CLI ?? "/opt/homebrew/bin/whisper-cli";
const WHISPER_MODEL = expandHome(
	process.env.PI_TELEGRAM_WHISPER_MODEL ?? "~/models/whisper.cpp/ggml-base.en.bin",
);
const OPUSDEC = process.env.PI_TELEGRAM_OPUSDEC ?? "/opt/homebrew/bin/opusdec";
const OPUSENC = process.env.PI_TELEGRAM_OPUSENC ?? "/opt/homebrew/bin/opusenc";
const AFCONVERT = "/usr/bin/afconvert";
const MLX_PYTHON = expandHome(
	process.env.PI_TELEGRAM_MLX_PYTHON ?? "~/Benchmarks/.venv/bin/python",
);
const KOKORO_MODEL = expandHome(
	process.env.PI_TELEGRAM_KOKORO_MODEL ?? "~/models/Kokoro-82M-MLX-bf16",
);
const KOKORO_VOICE = expandHome(
	process.env.PI_TELEGRAM_KOKORO_VOICE ?? "~/models/Kokoro-82M-MLX-bf16/voices/am_michael.safetensors",
);
const PYTHONPATH = expandHome(
	process.env.PI_TELEGRAM_TTS_PYTHONPATH ?? "~/tools/voice-notes/pydeps",
);

const MAX_TRANSCRIPT_CHARS = 5_000;
const MAX_TTS_INPUT_CHARS = 1_200;
const MAX_TTS_OUTPUT_BYTES = 5 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 120_000;
const STDERR_LIMIT_BYTES = 64 * 1024;

export interface GeneratedVoiceReply {
	path: string;
	directory: string;
}

function expandHome(value: string): string {
	return value.replace(/^~(?=\/|$)/, HOME);
}

function ensureNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Voice operation cancelled");
	}
}

async function runFile(
	command: string,
	args: string[],
	options: { timeout: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
	ensureNotAborted(options.signal);
	try {
		const result = await execFileAsync(command, args, {
			encoding: "utf8",
			maxBuffer: STDERR_LIMIT_BYTES,
			timeout: options.timeout,
			signal: options.signal,
			env: options.env,
			windowsHide: true,
		});
		return { stdout: result.stdout, stderr: result.stderr };
	} catch {
		throw new Error("Local audio processing failed");
	}
}

function runWithStdin(
	command: string,
	args: string[],
	input: string,
	options: { timeout: number; signal?: AbortSignal; env: NodeJS.ProcessEnv },
): Promise<void> {
	ensureNotAborted(options.signal);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: options.env,
			stdio: ["pipe", "ignore", "pipe"],
			windowsHide: true,
		});
		let settled = false;
		let stderrBytes = 0;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onAbort = (): void => {
			child.kill("SIGTERM");
			finish(new Error("Voice operation cancelled"));
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(new Error("Speech synthesis timed out"));
		}, options.timeout);

		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > STDERR_LIMIT_BYTES) child.kill("SIGTERM");
		});
		child.stdin.on("error", () => finish(new Error("Speech synthesis input failed")));
		child.once("error", () => finish(new Error("Speech synthesis could not start")));
		child.once("close", (code) => {
			if (code === 0) finish();
			else finish(new Error("Speech synthesis failed"));
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin.end(`${input}\n`);
	});
}

export function prepareSpeechText(text: string): string | undefined {
	const normalized = text.trim();
	if (!normalized || normalized.length > MAX_TTS_INPUT_CHARS) return undefined;
	if (/```|\b(?:password|passcode|secret|api key|access token|credential|private key)\b/i.test(normalized)) {
		return undefined;
	}
	if (/\b(?:token|key)\s*[:=]|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|\d{6,}:[A-Za-z0-9_-]{20,})\b/i.test(normalized)) {
		return undefined;
	}
	if (/(?:^|\s)(?:\/Users\/|~\/|\.env\b)/i.test(normalized)) return undefined;

	const spoken = normalized
		.replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/[*_~`]/g, "")
		.replace(/https?:\/\/\S+/gi, "")
		.replace(/\s+/g, " ")
		.trim();
	return spoken || undefined;
}

export async function transcribeVoiceNote(
	inputPath: string,
	workDirectory: string,
	signal?: AbortSignal,
): Promise<string> {
	const extension = extname(inputPath).toLowerCase();
	let whisperInput = inputPath;

	if (extension === ".ogg" || extension === ".opus") {
		whisperInput = join(workDirectory, "decoded.wav");
		await runFile(OPUSDEC, ["--quiet", "--rate", "16000", inputPath, whisperInput], {
			timeout: 60_000,
			signal,
		});
	} else if (extension === ".m4a" || extension === ".aac") {
		whisperInput = join(workDirectory, "decoded.wav");
		await runFile(AFCONVERT, ["-f", "WAVE", "-d", "LEI16@16000", inputPath, whisperInput], {
			timeout: 60_000,
			signal,
		});
	} else if (![".mp3", ".wav", ".flac"].includes(extension)) {
		throw new Error("Unsupported audio format");
	}

	const wavStats = await stat(whisperInput);
	if (wavStats.size > 48 * 1024 * 1024) {
		throw new Error("Decoded audio exceeds the processing limit");
	}

	const outputBase = join(workDirectory, "transcript");
	await runFile(
		WHISPER_CLI,
		[
			"-m", WHISPER_MODEL,
			"-l", "en",
			"-t", "4",
			"-f", whisperInput,
			"-otxt",
			"-of", outputBase,
			"-np",
			"-nt",
		],
		{ timeout: PROCESS_TIMEOUT_MS, signal },
	);

	const transcript = (await readFile(`${outputBase}.txt`, "utf8"))
		.replace(/\[BLANK_AUDIO\]/gi, "")
		.trim();
	if (!transcript) throw new Error("No speech detected");
	if (transcript.length > MAX_TRANSCRIPT_CHARS) {
		throw new Error("Transcript exceeds the processing limit");
	}
	return transcript;
}

export async function synthesizeVoiceReply(
	text: string,
	tempRoot: string,
	signal?: AbortSignal,
): Promise<GeneratedVoiceReply | undefined> {
	const speechText = prepareSpeechText(text);
	if (!speechText) return undefined;

	const directory = await mkdtemp(join(tempRoot, "tts-"));
	await chmod(directory, 0o700);
	try {
		await runWithStdin(
			MLX_PYTHON,
			[
				"-m", "mlx_audio.tts.generate",
				"--model", KOKORO_MODEL,
				"--voice", KOKORO_VOICE,
				"--output_path", directory,
				"--file_prefix", "reply",
				"--audio_format", "wav",
				"--join_audio",
			],
			speechText,
			{
				timeout: PROCESS_TIMEOUT_MS,
				signal,
				env: {
					...process.env,
					HF_HUB_OFFLINE: "1",
					HF_DATASETS_OFFLINE: "1",
					TRANSFORMERS_OFFLINE: "1",
					PYTHONPATH: [PYTHONPATH, process.env.PYTHONPATH].filter(Boolean).join(":"),
				},
			},
		);

		const wavName = (await readdir(directory)).find((name) => name.toLowerCase().endsWith(".wav"));
		if (!wavName) throw new Error("Speech synthesis produced no audio file");
		const wavPath = join(directory, wavName);
		const opusPath = join(directory, "reply.ogg");
		await runFile(OPUSENC, ["--quiet", "--speech", "--bitrate", "32", wavPath, opusPath], {
			timeout: 30_000,
			signal,
		});

		const opusStats = await stat(opusPath);
		if (opusStats.size > MAX_TTS_OUTPUT_BYTES) {
			throw new Error("Generated voice reply exceeds the upload limit");
		}
		await chmod(opusPath, 0o600);
		return { path: opusPath, directory };
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

export async function voiceRuntimeAvailable(): Promise<boolean> {
	const paths = [WHISPER_CLI, WHISPER_MODEL, OPUSDEC, OPUSENC, MLX_PYTHON, KOKORO_MODEL, KOKORO_VOICE, PYTHONPATH];
	try {
		await Promise.all(paths.map((path) => stat(path)));
		return true;
	} catch {
		return false;
	}
}
