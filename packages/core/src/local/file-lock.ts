import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Keeps two open-reels that share a models folder (the desktop app and
 * open-reel under WSL do) from working on the same file at once: two
 * downloads appending to one `.part` corrupt it, and one removing a model
 * would delete a file the other is still writing.
 *
 * The holder rewrites `<file>.lock` while it works, so the lock of an
 * open-reel that died goes stale and is taken over. Ages are read against
 * the folder's own clock: under WSL the Linux clock drifts from the Windows
 * one, which stamps the files.
 */

/** A lock not rewritten for this long belongs to an open-reel that died. */
export const LOCK_STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const POLL_MS = 1_000;

export interface FileLockOptions {
	/** Called each time it finds the lock held by another, while it waits. */
	onWait?: () => void | Promise<void>;
	pollMs?: number;
	staleMs?: number;
	heartbeatMs?: number;
}

/** The time on the folder's clock, read from a file written there now. */
function folderNow(dir: string): number {
	const probe = join(dir, `.clock-${crypto.randomUUID()}`);
	try {
		writeFileSync(probe, "");
		return statSync(probe).mtimeMs;
	} finally {
		rmSync(probe, { force: true });
	}
}

/** Whether another open-reel, alive, holds `lock`. */
export function isLocked(lock: string, staleMs = LOCK_STALE_MS): boolean {
	try {
		const { mtimeMs } = statSync(lock);
		return folderNow(dirname(lock)) - mtimeMs <= staleMs;
	} catch {
		return false;
	}
}

/**
 * Runs `fn` holding `lock`, waiting while another open-reel holds it.
 * Rejects as soon as `signal` aborts, waiting or not.
 */
export async function withFileLock<T>(
	lock: string,
	signal: AbortSignal,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const owner = crypto.randomUUID();
	const staleMs = options.staleMs ?? LOCK_STALE_MS;
	for (;;) {
		signal.throwIfAborted();
		try {
			writeFileSync(lock, owner, { flag: "wx" });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (!isLocked(lock, staleMs)) {
			// Left by an open-reel that died: take it over.
			rmSync(lock, { force: true });
			continue;
		}
		await options.onWait?.();
		await Bun.sleep(options.pollMs ?? POLL_MS);
	}
	const heartbeat = setInterval(() => {
		try {
			writeFileSync(lock, owner);
		} catch {
			// Unreachable for now; the next beat tries again.
		}
	}, options.heartbeatMs ?? HEARTBEAT_MS);
	heartbeat.unref?.();
	try {
		return await fn();
	} finally {
		clearInterval(heartbeat);
		try {
			// Only our own: a lock taken for dead may have been taken over.
			if (readFileSync(lock, "utf8") === owner) rmSync(lock);
		} catch {
			// Already gone.
		}
	}
}
