import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { CONFIG_PATH } from "./constants";
import type { TelegramConfig } from "./types";

export async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as TelegramConfig;
		return parsed;
	} catch {
		return {};
	}
}

export async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}
