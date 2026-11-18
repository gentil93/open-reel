import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Moved, moveBack, moveInto, treeSize } from "./move";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function folder(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "open-reel-move-"));
	dirs.push(dir);
	return dir;
}

const read = (path: string) => Bun.file(path).text();

describe("moving models", () => {
	test("moves a folder with everything below it, telling the bytes", async () => {
		const root = await folder();
		await mkdir(join(root, "from", "sub"), { recursive: true });
		await writeFile(join(root, "from", "a"), "aaaa");
		await writeFile(join(root, "from", "sub", "b"), "bb");
		expect(await treeSize(join(root, "from"))).toBe(6);

		let bytes = 0;
		const moved: Moved[] = [];
		await moveInto(
			join(root, "from"),
			join(root, "to"),
			(n) => {
				bytes += n;
			},
			moved,
		);
		expect(bytes).toBe(6);
		expect(await read(join(root, "to", "sub", "b"))).toBe("bb");
		expect(await readdir(root)).toEqual(["to"]);
		expect(moved).toHaveLength(1);
	});

	test("merges into a folder already there, keeping its files", async () => {
		const root = await folder();
		await mkdir(join(root, "from"));
		await mkdir(join(root, "to"));
		await writeFile(join(root, "from", "same"), "new");
		await writeFile(join(root, "from", "only-here"), "x");
		await writeFile(join(root, "to", "same"), "old");
		await moveInto(join(root, "from"), join(root, "to"), () => {}, []);
		// Model files are named by their hash: the one there is the same file.
		expect(await read(join(root, "to", "same"))).toBe("old");
		expect(await read(join(root, "to", "only-here"))).toBe("x");
		expect(await readdir(root)).toEqual(["to"]);
	});

	test("puts back what moved when told to", async () => {
		const root = await folder();
		await mkdir(join(root, "from"));
		await writeFile(join(root, "from", "a"), "a");
		const moved: Moved[] = [];
		await moveInto(join(root, "from"), join(root, "to"), () => {}, moved);
		await moveBack(moved);
		expect(await read(join(root, "from", "a"))).toBe("a");
		expect(await readdir(root)).toEqual(["from"]);
	});

	test("makes the folders the new place needs", async () => {
		const root = await folder();
		await writeFile(join(root, "a"), "a");
		await moveInto(
			join(root, "a"),
			join(root, "new", "deep", "a"),
			() => {},
			[],
		);
		expect(await read(join(root, "new", "deep", "a"))).toBe("a");
	});

	test("something that is not there is nothing to move", async () => {
		const root = await folder();
		const moved: Moved[] = [];
		await moveInto(join(root, "none"), join(root, "to"), () => {}, moved);
		expect(moved).toEqual([]);
		expect(await readdir(root)).toEqual([]);
	});
});
