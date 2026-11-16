import { homedir } from "node:os";
import { join } from "node:path";
import { detectHardware } from "./local/hardware";

/** Directory for the database, assets and stored keys. */
export function defaultDataDir(): string {
	if (process.env.OPEN_REEL_DATA_DIR) return process.env.OPEN_REEL_DATA_DIR;
	const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	return join(base, "open-reel");
}

async function output(argv: string[]): Promise<string | null> {
	try {
		const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
		const [text, code] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		return code === 0 ? text.replaceAll("\r", "").trim() : null;
	} catch {
		return null;
	}
}

/**
 * Directory for downloaded models and engines. Under WSL it is on the Windows
 * side: engines run there as Windows programs, and they read files on the
 * Linux side about twenty times slower.
 */
export async function defaultModelsDir(dataDir: string): Promise<string> {
	if (process.env.OPEN_REEL_MODELS_DIR) return process.env.OPEN_REEL_MODELS_DIR;
	if ((await detectHardware({ run: async () => null })).wsl) {
		const windows = await output(["cmd.exe", "/c", "echo", "%LOCALAPPDATA%"]);
		const linux =
			windows && !windows.includes("%")
				? await output(["wslpath", "-u", windows])
				: null;
		if (linux) return join(linux, "open-reel", "models");
	}
	return join(dataDir, "models");
}
