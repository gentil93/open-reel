import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { detectHardware } from "./local/hardware";

/** Directory for the database, assets and stored keys, where each system expects it. */
export function defaultDataDir(
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	if (env.OPEN_REEL_DATA_DIR) return env.OPEN_REEL_DATA_DIR;
	if (platform === "win32") {
		return win32.join(
			env.APPDATA ?? win32.join(home, "AppData", "Roaming"),
			"open-reel",
		);
	}
	if (platform === "darwin") {
		return join(home, "Library", "Application Support", "open-reel");
	}
	return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "open-reel");
}

/**
 * `\\?\C:\...` turns into `C:\...`: in that form Windows takes no forward
 * slashes, and the libraries reading these folders join paths with them.
 */
export function plainPath(path: string): string {
	return /^\\\\\?\\[A-Za-z]:\\/.test(path) ? path.slice(4) : path;
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
