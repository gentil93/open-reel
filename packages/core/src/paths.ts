import { homedir } from "node:os";
import { join } from "node:path";

/** Directory for the database, assets and stored keys. */
export function defaultDataDir(): string {
	if (process.env.OPEN_REEL_DATA_DIR) return process.env.OPEN_REEL_DATA_DIR;
	const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	return join(base, "open-reel");
}
