import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
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
 * Directory for downloaded models and engines. On Windows it is the local
 * app data, never the roaming one that may be synced between computers.
 * Under WSL it is that same Windows folder: engines run there as Windows
 * programs, and they read files on the Linux side about twenty times slower.
 * So the desktop app and open-reel under WSL share what they download.
 */
export async function defaultModelsDir(
	dataDir: string,
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	if (env.OPEN_REEL_MODELS_DIR) return env.OPEN_REEL_MODELS_DIR;
	if (platform === "win32") {
		return env.LOCALAPPDATA
			? win32.join(env.LOCALAPPDATA, "open-reel", "models")
			: win32.join(dataDir, "models");
	}
	if (
		platform === "linux" &&
		(await detectHardware({ run: async () => null })).wsl
	) {
		const windows = await output(["cmd.exe", "/c", "echo", "%LOCALAPPDATA%"]);
		const linux =
			windows && !windows.includes("%")
				? await output(["wslpath", "-u", windows])
				: null;
		if (linux) return join(linux, "open-reel", "models");
	}
	return join(dataDir, "models");
}

/**
 * Where a models folder chosen by hand is written down: next to the default
 * one, so every open-reel that shares the default folder (the desktop app
 * and open-reel under WSL) follows the same choice.
 */
export function modelsLocationFile(defaultModelsDir: string): string {
	const path = /^[A-Za-z]:\\/.test(defaultModelsDir) ? win32 : posix;
	return path.join(path.dirname(defaultModelsDir), "models-location.json");
}

/**
 * A folder as written by any open-reel sharing the choice, as this system
 * names it: `D:\Models` is `/mnt/d/Models` under WSL, and back. Null when
 * this system cannot reach it.
 */
export function pathHere(
	path: string,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const drive = path.match(/^([A-Za-z]):[\\/](.*)$/);
	const mounted = path.match(/^\/mnt\/([a-z])(?:\/(.*))?$/);
	if (platform === "win32") {
		if (drive) return path;
		if (mounted) {
			return win32.join(
				`${mounted[1]?.toUpperCase()}:\\`,
				...(mounted[2] ?? "").split("/").filter(Boolean),
			);
		}
		return null;
	}
	if (drive) {
		// Only under WSL do Windows drives show, under /mnt.
		return platform === "linux"
			? posix.join(
					`/mnt/${drive[1]?.toLowerCase()}`,
					...(drive[2] ?? "").split(/[\\/]/).filter(Boolean),
				)
			: null;
	}
	return posix.isAbsolute(path) ? path : null;
}

/** How to write a folder down so the other side of WSL reads it too. */
export function portablePath(path: string): string {
	const mounted = path.match(/^\/mnt\/([a-z])(?:\/(.*))?$/);
	if (!mounted) return path;
	return win32.join(
		`${mounted[1]?.toUpperCase()}:\\`,
		...(mounted[2] ?? "").split("/").filter(Boolean),
	);
}

/** The models folder chosen by hand, if any, else the default one. */
export async function chosenModelsDir(
	defaultModelsDir: string,
	platform: NodeJS.Platform = process.platform,
): Promise<string> {
	const file = Bun.file(modelsLocationFile(defaultModelsDir));
	const chosen = await file
		.json()
		.then((body: { path?: unknown }) =>
			typeof body.path === "string" ? pathHere(body.path, platform) : null,
		)
		.catch(() => null);
	return chosen ?? defaultModelsDir;
}
