import { afterEach, describe, expect, test } from "bun:test";
import {
	link,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanUp, type Mirror, mirrorInto, treeSize, undo } from "./move";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function folder(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-move-"));
	dirs.push(dir);
	return dir;
}

const read = (path: string) => Bun.file(path).text();
const empty = (): Mirror => ({ made: [], old: [] });
const options = (report: (bytes: number) => void = () => {}) => ({
	report,
	keep: (path: string) => !path.endsWith(".json"),
});

describe("moving models", () => {
	test("mirrors a folder, leaving the old one whole until cleaned up", async () => {
		const root = await folder();
		await mkdir(join(root, "from", "sub"), { recursive: true });
		await writeFile(join(root, "from", "a"), "aaaa");
		await writeFile(join(root, "from", "sub", "b"), "bb");
		expect(await treeSize(join(root, "from"))).toBe(6);

		let bytes = 0;
		const mirror = empty();
		await mirrorInto(
			join(root, "from"),
			join(root, "to"),
			mirror,
			options((n) => {
				bytes += n;
			}),
		);
		expect(bytes).toBe(6);
		expect(await read(join(root, "to", "sub", "b"))).toBe("bb");
		// Nothing of the old folder is gone yet.
		expect(await read(join(root, "from", "sub", "b"))).toBe("bb");

		await cleanUp(mirror, root);
		expect(await readdir(root)).toEqual(["to"]);
		expect(await read(join(root, "to", "a"))).toBe("aaaa");
	});

	test("undo leaves the old folder as it was", async () => {
		const root = await folder();
		await mkdir(join(root, "from"));
		await writeFile(join(root, "from", "a"), "a");
		const mirror = empty();
		await mirrorInto(join(root, "from"), join(root, "to"), mirror, options());
		expect(await undo(mirror)).toEqual([]);
		expect(await read(join(root, "from", "a"))).toBe("a");
		expect(await readdir(join(root, "to"))).toEqual([]);
	});

	test("merges into a folder there, keeping its model files", async () => {
		const root = await folder();
		await mkdir(join(root, "from"));
		await mkdir(join(root, "to"));
		await writeFile(join(root, "from", "hash"), "new");
		await writeFile(join(root, "from", "marker.json"), "mine");
		await writeFile(join(root, "to", "hash"), "old");
		await writeFile(join(root, "to", "marker.json"), "theirs");
		await writeFile(join(root, "to", "other"), "x");
		const mirror = empty();
		await mirrorInto(join(root, "from"), join(root, "to"), mirror, options());
		// Named by its hash: the one there is the same file.
		expect(await read(join(root, "to", "hash"))).toBe("old");
		// A marker says what this folder holds: it replaces the one there.
		expect(await read(join(root, "to", "marker.json"))).toBe("mine");
		// Undo deletes only what it made: the folder that was there stays.
		await undo(mirror);
		expect((await readdir(join(root, "to"))).sort()).toEqual([
			"hash",
			"marker.json",
			"other",
		]);
		expect(await read(join(root, "from", "hash"))).toBe("new");
	});

	test("refuses the same folder under another name, deleting nothing", async () => {
		const root = await folder();
		await mkdir(join(root, "models"));
		await writeFile(join(root, "models", "a"), "a");
		await symlink(join(root, "models"), join(root, "alias"));
		const mirror = empty();
		await expect(
			mirrorInto(join(root, "models"), join(root, "alias"), mirror, options()),
		).rejects.toThrow("itself");
		await cleanUp(mirror, root);
		expect(await read(join(root, "models", "a"))).toBe("a");
	});

	test("a folder made whole shows only once all its files are there", async () => {
		const root = await folder();
		await mkdir(join(root, "engines", "build"), { recursive: true });
		await writeFile(join(root, "engines", "build", "run"), "program");
		const mirror = empty();
		await mirrorInto(join(root, "engines"), join(root, "new"), mirror, {
			...options(),
			whole: (path) => path.endsWith("build"),
		});
		expect(await read(join(root, "new", "build", "run"))).toBe("program");
		// Nothing half made is left aside.
		expect(await readdir(join(root, "new"))).toEqual(["build"]);
		await cleanUp(mirror, root);
		expect(await readdir(root)).toEqual(["new"]);
	});

	test("files that only matter for a moment stay behind", async () => {
		const root = await folder();
		await mkdir(join(root, "from"));
		await writeFile(join(root, "from", "a"), "a");
		await writeFile(join(root, "from", "a.lock"), "someone");
		await writeFile(join(root, "from", ".clock-1"), "");
		await mirrorInto(join(root, "from"), join(root, "to"), empty(), options());
		expect(await readdir(join(root, "to"))).toEqual(["a"]);
	});

	test("a file left with two names by an earlier move counts as there", async () => {
		const root = await folder();
		await mkdir(join(root, "from"));
		await mkdir(join(root, "to"));
		await writeFile(join(root, "from", "a"), "a");
		await link(join(root, "from", "a"), join(root, "to", "a"));
		const mirror = empty();
		await mirrorInto(join(root, "from"), join(root, "to"), mirror, options());
		await cleanUp(mirror, root);
		expect(await read(join(root, "to", "a"))).toBe("a");
	});

	test("a half-made engine there is made again whole", async () => {
		const root = await folder();
		await mkdir(join(root, "engines", "build"), { recursive: true });
		await writeFile(join(root, "engines", "build", "run"), "program");
		await writeFile(join(root, "engines", "build", "lib"), "library");
		await mkdir(join(root, "new", "build"), { recursive: true });
		await writeFile(join(root, "new", "build", "run"), "program");
		const mirror = empty();
		await mirrorInto(join(root, "engines"), join(root, "new"), mirror, {
			...options(),
			whole: (path) => path.endsWith("build"),
		});
		expect((await readdir(join(root, "new", "build"))).sort()).toEqual([
			"lib",
			"run",
		]);
	});

	test("of two interrupted downloads, the one further along is kept", async () => {
		const root = await folder();
		await mkdir(join(root, "from"));
		await mkdir(join(root, "to"));
		await writeFile(join(root, "from", "x.part"), "further along");
		await writeFile(join(root, "to", "x.part"), "less");
		await mirrorInto(join(root, "from"), join(root, "to"), empty(), options());
		expect(await read(join(root, "to", "x.part"))).toBe("further along");
	});

	test("cleaning up leaves a folder something new was written to", async () => {
		const root = await folder();
		await mkdir(join(root, "from"));
		await writeFile(join(root, "from", "a"), "a");
		const mirror = empty();
		await mirrorInto(join(root, "from"), join(root, "to"), mirror, options());
		await writeFile(join(root, "from", "new"), "written meanwhile");
		await cleanUp(mirror, root);
		expect(await readdir(join(root, "from"))).toEqual(["new"]);
	});
});
