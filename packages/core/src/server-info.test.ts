import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearServerInfo,
	readServerInfo,
	serverInfoFile,
	writeServerInfo,
} from "./server-info";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function dataDir() {
	const dir = await mkdtemp(join(tmpdir(), "open-reel-info-"));
	dirs.push(dir);
	return dir;
}

test("a running server is found where it said it listens", async () => {
	const dir = await dataDir();
	expect(await readServerInfo(dir)).toBeNull();
	const info = { pid: process.pid, url: "http://127.0.0.1:4100" };
	await writeServerInfo(dir, info);
	expect(await readServerInfo(dir)).toEqual(info);
	await clearServerInfo(dir);
	expect(await readServerInfo(dir)).toBeNull();
});

test("a server that is gone, or a file that says too much, is not found", async () => {
	const dir = await dataDir();
	await writeServerInfo(dir, { pid: 123, url: "http://127.0.0.1:4100" });
	expect(await readServerInfo(dir, () => false)).toBeNull();
	// Only this machine's loopback: the file is not trusted to point elsewhere.
	await writeServerInfo(dir, { pid: process.pid, url: "http://evil.example" });
	expect(await readServerInfo(dir)).toBeNull();
	await writeFile(serverInfoFile(dir), "not json");
	expect(await readServerInfo(dir)).toBeNull();
});

test("only the process that wrote it removes it", async () => {
	const dir = await dataDir();
	const other = { pid: process.pid + 1, url: "http://127.0.0.1:4100" };
	await writeServerInfo(dir, other);
	await clearServerInfo(dir);
	expect(await readServerInfo(dir, () => true)).toEqual(other);
});
