import { afterEach, describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocked, withFileLock } from "./file-lock";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function lockPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	dirs.push(dir);
	return join(dir, "file.lock");
}

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

const signal = () => new AbortController().signal;

describe("file locks", () => {
	test("a second holder waits until the first is done", async () => {
		const lock = await lockPath();
		const order: string[] = [];
		const first = gate();
		const a = withFileLock(lock, signal(), async () => {
			order.push("a starts");
			await first.promise;
			order.push("a ends");
		});
		await Bun.sleep(10);
		let waits = 0;
		const b = withFileLock(
			lock,
			signal(),
			async () => {
				order.push("b runs");
			},
			{ pollMs: 5, onWait: () => void waits++ },
		);
		await Bun.sleep(30);
		expect(isLocked(lock)).toBe(true);
		expect(order).toEqual(["a starts"]);
		first.open();
		await Promise.all([a, b]);
		expect(order).toEqual(["a starts", "a ends", "b runs"]);
		expect(waits).toBeGreaterThan(0);
		expect(isLocked(lock)).toBe(false);
	});

	test("the lock of a Hatchlight that died is taken over", async () => {
		const lock = await lockPath();
		await writeFile(lock, "someone gone");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		expect(isLocked(lock)).toBe(false);
		expect(await withFileLock(lock, signal(), async () => "ran")).toBe("ran");
	});

	test("canceling stops the wait", async () => {
		const lock = await lockPath();
		const held = gate();
		const a = withFileLock(lock, signal(), () => held.promise);
		await Bun.sleep(10);
		const controller = new AbortController();
		const b = withFileLock(lock, controller.signal, async () => "ran", {
			pollMs: 5,
		});
		await Bun.sleep(20);
		controller.abort(new Error("canceled"));
		await expect(b).rejects.toThrow("canceled");
		held.open();
		await a;
	});

	test("a failing holder still lets go, and leaves nothing behind", async () => {
		const lock = await lockPath();
		await expect(
			withFileLock(lock, signal(), async () => {
				throw new Error("broke");
			}),
		).rejects.toThrow("broke");
		expect(isLocked(lock)).toBe(false);
		// Neither the lock nor the files used to read the folder's clock.
		expect(await readdir(join(lock, ".."))).toEqual([]);
	});

	test("the holder keeps its lock alive while it works", async () => {
		const lock = await lockPath();
		const held = gate();
		const a = withFileLock(lock, signal(), () => held.promise, {
			heartbeatMs: 5,
		});
		await Bun.sleep(10);
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		await Bun.sleep(20);
		expect(isLocked(lock)).toBe(true);
		held.open();
		await a;
	});
});
