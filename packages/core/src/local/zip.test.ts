import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zip } from "./testing";
import { extractZip } from "./zip";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-zip-"));
	dirs.push(dir);
	return dir;
}

async function extract(archive: Uint8Array) {
	const dir = await tempDir();
	const path = join(dir, "archive.zip");
	await Bun.write(path, archive);
	const out = join(dir, "out");
	await extractZip(path, out);
	return out;
}

const text = (value: string) => new TextEncoder().encode(value);

test("extracts stored and deflated files, in folders", async () => {
	const big = text("weights ".repeat(400_000)); // spans many read chunks
	const out = await extract(
		zip([
			{ name: "sd-cli.exe", data: text("binary"), method: 0 },
			{ name: "lib/", method: 0 },
			{ name: "lib/ggml.dll", data: big },
			{ name: "empty.txt" },
		]),
	);
	expect((await readdir(out)).sort()).toEqual([
		"empty.txt",
		"lib",
		"sd-cli.exe",
	]);
	expect(await Bun.file(join(out, "sd-cli.exe")).text()).toBe("binary");
	expect(await Bun.file(join(out, "lib", "ggml.dll")).bytes()).toEqual(big);
	expect(await Bun.file(join(out, "empty.txt")).size).toBe(0);
});

test("reads sizes and offsets from zip64 fields", async () => {
	const out = await extract(
		zip(
			[
				{ name: "a.txt", data: text("first") },
				{ name: "b.txt", data: text("second") },
			],
			{ zip64: true },
		),
	);
	expect(await Bun.file(join(out, "b.txt")).text()).toBe("second");
});

test("refuses paths that would leave the destination", async () => {
	for (const name of [
		"../escape.txt",
		"/etc/passwd",
		"a/../../b",
		"C:/x",
		"..\\x",
	]) {
		expect(extract(zip([{ name, data: text("x") }]))).rejects.toThrow(
			"unsafe path",
		);
	}
});

test("a damaged file is caught by its checksum and not left behind", async () => {
	const dir = await tempDir();
	const path = join(dir, "archive.zip");
	await Bun.write(
		path,
		zip([
			{ name: "good.txt", data: text("good") },
			{ name: "bad.txt", data: text("bad"), crc: 1234 },
		]),
	);
	const out = join(dir, "out");
	expect(extractZip(path, out)).rejects.toThrow("bad.txt is damaged");
	await Bun.sleep(10);
	expect(await readdir(out)).toEqual(["good.txt"]);
});

test("refuses what is not a zip, or is cut short", async () => {
	expect(extract(text("not an archive at all"))).rejects.toThrow(
		"Not a zip archive",
	);
	const whole = zip([
		{ name: "a.txt", data: text("x".repeat(1000)), method: 0 },
	]);
	const cut = Buffer.concat([whole.slice(0, 500), whole.slice(-22)]);
	expect(extract(cut)).rejects.toThrow();
});
