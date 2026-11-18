import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Something moved, to put back if a later move fails. */
export interface Moved {
	from: string;
	to: string;
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

/**
 * Moves `from` to `to`, a file or a folder, merging into a folder already
 * there. A file already at `to` is kept and the one at `from` dropped: model
 * files are named by their hash, so they are the same. Renames when both are
 * on one disk; across disks, copies and then deletes. Each move is recorded
 * in `moved`, and `report` is told the bytes as they arrive.
 */
export async function moveInto(
	from: string,
	to: string,
	report: (bytes: number) => void,
	moved: Moved[],
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const source = await stat(from).catch(() => null);
	if (!source) return;
	const there = await stat(to).catch(() => null);
	if (there) {
		if (source.isDirectory() && there.isDirectory()) {
			for (const name of await readdir(from)) {
				await moveInto(join(from, name), join(to, name), report, moved, signal);
			}
			await rm(from, { recursive: true, force: true });
		} else {
			report(await treeSize(from));
			await rm(from, { recursive: true, force: true });
		}
		return;
	}
	const size = await treeSize(from);
	await mkdir(dirname(to), { recursive: true });
	try {
		await rename(from, to);
		moved.push({ from, to });
		report(size);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
	}
	// Another disk.
	if (source.isDirectory()) {
		await mkdir(to, { recursive: true });
		for (const name of await readdir(from)) {
			await moveInto(join(from, name), join(to, name), report, moved, signal);
		}
		await rm(from, { recursive: true, force: true });
		return;
	}
	// Copied under another name first, so a copy cut short is never taken
	// for the file.
	const partial = `${to}.moving`;
	try {
		await copyFile(from, partial);
		await rename(partial, to);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
	moved.push({ from, to });
	await rm(from, { force: true });
	report(size);
}

/** Puts back what `moveInto` moved, newest first. */
export async function moveBack(moved: Moved[]): Promise<void> {
	for (const { from, to } of [...moved].reverse()) {
		await mkdir(join(from, ".."), { recursive: true }).catch(() => {});
		await moveInto(to, from, () => {}, []).catch(() => {});
	}
}
