import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
	streamPreviews?: boolean;
	richText?: boolean;
}

export type TelegramStorageScope = "project" | "global";

export interface TelegramStorage {
	scope: TelegramStorageScope;
	configPath: string;
	tempDir: string;
}

export function parseTelegramStorageScopeArg(
	args: string,
): { ok: true; scope?: TelegramStorageScope } | { ok: false; message: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { ok: true, scope: undefined };
	if (tokens.length !== 1) return { ok: false, message: "usage: local|global" };
	const token = tokens[0].toLowerCase();
	if (token === "local" || token === "--local") return { ok: true, scope: "project" };
	if (token === "global" || token === "--global") return { ok: true, scope: "global" };
	return { ok: false, message: "usage: local|global" };
}

export function getProjectTelegramPaths(cwd: string): TelegramStorage {
	return {
		scope: "project",
		configPath: join(cwd, ".pi", "telegram.json"),
		tempDir: join(cwd, ".pi", "tmp", "telegram"),
	};
}

export function getGlobalTelegramPaths(homeDir = homedir()): TelegramStorage {
	return {
		scope: "global",
		configPath: join(homeDir, ".pi", "agent", "telegram.json"),
		tempDir: join(homeDir, ".pi", "agent", "tmp", "telegram"),
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function resolveTelegramStorage(cwd: string, options?: { homeDir?: string; scope?: TelegramStorageScope }): Promise<TelegramStorage> {
	const project = getProjectTelegramPaths(cwd);
	const global = getGlobalTelegramPaths(options?.homeDir);
	if (options?.scope === "project") return project;
	if (options?.scope === "global") return global;
	if (await pathExists(project.configPath)) return project;
	if (await pathExists(global.configPath)) return global;
	return project;
}

export async function readTelegramConfig(storage: TelegramStorage): Promise<TelegramConfig> {
	try {
		const content = await readFile(storage.configPath, "utf8");
		return JSON.parse(content) as TelegramConfig;
	} catch {
		return {};
	}
}

export async function writeTelegramConfig(storage: TelegramStorage, config: TelegramConfig): Promise<void> {
	await mkdir(dirname(storage.configPath), { recursive: true });
	await writeFile(storage.configPath, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

const TELEGRAM_GITIGNORE_COMMENT = "# pi-telegram local secrets/cache";
const TELEGRAM_GITIGNORE_CONFIG_ENTRY = ".pi/telegram.json";
const TELEGRAM_GITIGNORE_TEMP_ENTRY = ".pi/tmp/telegram/";
const TELEGRAM_GITIGNORE_BLOCK = `${TELEGRAM_GITIGNORE_COMMENT}\n${TELEGRAM_GITIGNORE_CONFIG_ENTRY}\n${TELEGRAM_GITIGNORE_TEMP_ENTRY}\n`;

export async function ensureProjectTelegramGitIgnore(cwd: string): Promise<void> {
	await mkdir(cwd, { recursive: true });
	const gitIgnorePath = join(cwd, ".gitignore");
	let existing = "";
	try {
		existing = await readFile(gitIgnorePath, "utf8");
	} catch {
		// ignore missing file
	}
	const hasConfigEntry = existing.includes(`${TELEGRAM_GITIGNORE_CONFIG_ENTRY}\n`) || existing.endsWith(TELEGRAM_GITIGNORE_CONFIG_ENTRY);
	const hasTempEntry = existing.includes(`${TELEGRAM_GITIGNORE_TEMP_ENTRY}\n`) || existing.endsWith(TELEGRAM_GITIGNORE_TEMP_ENTRY);
	if (hasConfigEntry && hasTempEntry) return;
	const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
	await writeFile(gitIgnorePath, prefix + TELEGRAM_GITIGNORE_BLOCK, "utf8");
}
