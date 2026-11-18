import {
	copyFile,
	link,
	mkdir,
	readdir,
	rename,
	rm,
	rmdir,
	stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Moving the models to another folder happens in three steps, so that the
 * folder in use is never left without them:
 *
 * 1. `mirror` places every file in the new folder too, leaving the old one
 *    whole: a hard link within one disk (instant, and no room taken), a copy
 *    across disks.
 * 2. The caller writes the new folder down and starts using it.
 * 3. `cleanUp` then deletes the old files, one by one.
 *
 * Until the second step, `undo` deletes what the first one made, and the old
 * folder is as it was.
 */
export interface Mirror {
	/** What was made in the new folder, to delete on undo. */
	made: string[];
	/** The old files and folders, to delete once the move is done. */
	old: string[];
}

/** What a file or folder takes, counting every file below it. */
export async function treeSize(path: string): Promise<number> {
	const info = await stat(path).catch(() => null);
	if (!info) return 0;
	if (!info.isDirectory()) return info.size;
	let total = 0;
	for (const name of await readdir(path)) {
		total += await treeSize(join(path, name));
	}
	return total;
}

/** Names that only matter to the open-reel that made them, now. */
function passing(name: string): boolean {
	return (
		name.endsWith(".lock") ||
		name.endsWith(".stale") ||
		name.endsWith(".moving") ||
		name.endsWith(".tmp") ||
		name.startsWith(".clock-")
	);
}

export interface MirrorOptions {
	/** Told the bytes of each file as it is placed. */
	report: (bytes: number) => void;
	/**
	 * Whether a file already in the new folder is kept rather than replaced.
	 * Model files are named by their hash, so one there is the same file.
	 */
	keep: (path: string) => boolean;
	signal?: AbortSignal;
}

/**
 * Places `from` (a file or a folder) at `to` as well, recording it in
 * `mirror`. A folder whose files must all be there together (an engine) is
 * made aside and renamed into place at the end, so it never shows half made.
 */
export async function mirrorInto(
	from: string,
	to: string,
	mirror: Mirror,
	options: MirrorOptions & { whole?: (path: string) => boolean },
): Promise<void> {
	options.signal?.throwIfAborted();
	const source = await stat(from).catch(() => null);
	if (!source) return;
	const there = await stat(to).catch(() => null);
	// The same file under another name (case, a link, a short name): cleaning
	// up would delete the only copy.
	if (there && there.dev === source.dev && there.ino === source.ino) {
		throw new Error(`${to} is ${from} itself`);
	}
	if (source.isDirectory()) {
		if (there && !there.isDirectory()) {
			throw new Error(`${to} is in the way`);
		}
		if (there && options.whole?.(from)) {
			// Already complete there (it is only renamed into place whole).
			mirror.old.push(from);
			options.report(await treeSize(from));
			return;
		}
		if (!there && options.whole?.(from)) {
			const aside = `${to}.${crypto.randomUUID()}.moving`;
			const inner: Mirror = { made: [], old: [] };
			try {
				await mkdir(aside, { recursive: true });
				for (const name of await readdir(from)) {
					if (passing(name)) continue;
					await mirrorInto(join(from, name), join(aside, name), inner, options);
				}
				await rename(aside, to);
			} catch (error) {
				await rm(aside, { recursive: true, force: true });
				throw error;
			}
			mirror.made.push(to);
			mirror.old.push(from);
			return;
		}
		await mkdir(to, { recursive: true });
		for (const name of await readdir(from)) {
			if (passing(name)) continue;
			await mirrorInto(join(from, name), join(to, name), mirror, options);
		}
		return;
	}
	if (there && options.keep(from)) {
		mirror.old.push(from);
		options.report(source.size);
		return;
	}
	// Placed under another name first, so a copy cut short is never taken for
	// the file.
	const partial = `${to}.${crypto.randomUUID()}.moving`;
	await mkdir(dirname(to), { recursive: true });
	try {
		try {
			await link(from, partial);
		} catch {
			// Another disk, or one without hard links.
			await copyFile(from, partial);
		}
		if (there) {
			// Replaced only once the new one is whole.
			await rename(partial, to);
		} else {
			await rename(partial, to);
			mirror.made.push(to);
		}
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
	mirror.old.push(from);
	options.report(source.size);
}

/** Deletes what `mirrorInto` made, leaving the old folder as it was. */
export async function undo(mirror: Mirror): Promise<string[]> {
	const failed: string[] = [];
	for (const path of [...mirror.made].reverse()) {
		await rm(path, { recursive: true, force: true }).catch(() => {
			failed.push(path);
		});
	}
	return failed;
}

/**
 * Deletes the old files once the move is done, then the folders they leave
 * empty. A folder something else was written to meanwhile is left alone.
 */
export async function cleanUp(mirror: Mirror, root: string): Promise<void> {
	const folders = new Set<string>();
	for (const path of mirror.old) {
		const info = await stat(path).catch(() => null);
		if (!info) continue;
		// Only folders made whole elsewhere (engines) go at once.
		await rm(path, { recursive: info.isDirectory(), force: true }).catch(
			() => {},
		);
		for (let dir = dirname(path); dir.startsWith(root) && dir !== root; ) {
			folders.add(dir);
			dir = dirname(dir);
		}
	}
	// Deepest first; rmdir fails on a folder that is not empty.
	for (const dir of [...folders].sort((a, b) => b.length - a.length)) {
		await rmdir(dir).catch(() => {});
	}
}
