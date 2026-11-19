import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where a running Hatchlight can be reached, for other processes to find. */
export interface ServerInfo {
	pid: number;
	url: string;
}

/** The file a running server writes in its data directory. */
export const serverInfoFile = (dataDir: string) =>
	join(dataDir, "hatchlight.server.json");

/** Says where this server listens, once it owns the data directory. */
export async function writeServerInfo(
	dataDir: string,
	info: ServerInfo,
): Promise<void> {
	// Whole or not at all: a reader never sees half of it.
	const file = serverInfoFile(dataDir);
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(info));
	await rename(tmp, file);
}

/** Removes what `writeServerInfo` wrote, if it is still this process's. */
export async function clearServerInfo(dataDir: string): Promise<void> {
	const info = await readServerInfo(dataDir, () => true);
	if (info?.pid === process.pid) {
		await rm(serverInfoFile(dataDir), { force: true });
	}
}

const running = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// The process is there, only not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** The server running on a data directory, or null when none is. */
export async function readServerInfo(
	dataDir: string,
	alive: (pid: number) => boolean = running,
): Promise<ServerInfo | null> {
	try {
		const info = JSON.parse(
			await readFile(serverInfoFile(dataDir), "utf8"),
		) as Partial<ServerInfo>;
		if (
			typeof info.pid !== "number" ||
			typeof info.url !== "string" ||
			!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(info.url)
		) {
			return null;
		}
		return alive(info.pid) ? { pid: info.pid, url: info.url } : null;
	} catch {
		return null;
	}
}
