import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRANSLATE_INSTRUCTIONS } from "../translate";
import type { Spawn } from "./provider";
import type { LocalRuntime } from "./store";
import { chatPrompt, LocalTranslator, type RunOnce } from "./translator";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function setup(throughWindows: boolean) {
	const scratch = await mkdtemp(join(tmpdir(), "open-reel-translate-"));
	dirs.push(scratch);
	const runtime = {
		executable: "/engines/llama/llama-server.exe",
		files: { model: "/blobs/qwen" },
		throughWindows,
		scratch,
	} as unknown as LocalRuntime;
	const store = {
		runtime: async () => runtime,
		list: async () => ({
			models: [{ id: "qwen", ready: true }],
		}),
	};
	return { store: store as never, scratch };
}

/** A fake llama-server: healthy once started, answering chats. */
function fakeServer(reply = "a red fox in the snow") {
	const started: string[][] = [];
	const asked: unknown[] = [];
	let killed = 0;
	const exits: ((code: number) => void)[] = [];
	const spawn: Spawn = (argv) => {
		started.push(argv);
		let exit: (code: number) => void = () => {};
		const exited = new Promise<number>((resolve) => {
			exit = resolve;
		});
		exits.push((code) => exit(code));
		return {
			output: (async function* () {
				yield "main: server is listening";
				await exited;
			})(),
			exited,
			kill: () => {
				killed++;
				exit(0);
			},
		};
	};
	const fetch = async (url: string, init?: RequestInit) => {
		if (url.endsWith("/health")) return new Response("{}");
		asked.push(JSON.parse(String(init?.body)));
		return Response.json({ choices: [{ message: { content: reply } }] });
	};
	return {
		spawn,
		fetch,
		started,
		asked,
		killed: () => killed,
		/** The newest server dies on its own. */
		crash: () => exits.at(-1)?.(1),
	};
}

describe("the local translator", () => {
	test("keeps the model loaded in a server between prompts", async () => {
		const { store } = await setup(false);
		const server = fakeServer();
		const translator = new LocalTranslator({
			store,
			model: "qwen",
			spawn: server.spawn,
			fetch: server.fetch,
			freePort: async () => 4321,
		});
		const signal = new AbortController().signal;
		expect(await translator.toEnglish("uma raposa na neve", signal)).toBe(
			"a red fox in the snow",
		);
		await translator.toEnglish("outra raposa", signal);
		expect(server.started).toHaveLength(1);
		expect(server.started[0]).toEqual([
			"/engines/llama/llama-server.exe",
			"-m",
			"/blobs/qwen",
			"--host",
			"127.0.0.1",
			"--port",
			"4321",
			"-c",
			"2048",
			"-np",
			"1",
		]);
		expect(server.asked[0]).toMatchObject({
			messages: [
				{ role: "system", content: TRANSLATE_INSTRUCTIONS },
				{ role: "user", content: "uma raposa na neve" },
			],
			temperature: 0,
		});
		translator.stop();
		await Bun.sleep(0);
		expect(server.killed()).toBe(1);
	});

	test("under WSL runs the model once per prompt, through a file", async () => {
		const { store, scratch } = await setup(true);
		const runs: string[][] = [];
		let promptText = "";
		const run: RunOnce = async (argv) => {
			runs.push(argv);
			promptText = await Bun.file(
				argv[argv.indexOf("-f") + 1] as string,
			).text();
			return { code: 0, stdout: "\na red fox [end of text]\n", stderr: "" };
		};
		const translator = new LocalTranslator({
			store,
			model: "qwen",
			run,
			windowsPath: async (path) => path,
		});
		const english = await translator.toEnglish(
			"uma raposa",
			new AbortController().signal,
		);
		// Without the mark of where the model stopped.
		expect(english).toBe("a red fox");
		expect(runs[0]?.[0]).toBe("/engines/llama/llama-completion.exe");
		expect(runs[0]).toContain("-no-cnv");
		// It would silence the translation too.
		expect(runs[0]).not.toContain("--log-disable");
		expect(promptText).toBe(chatPrompt(TRANSLATE_INSTRUCTIONS, "uma raposa"));
		// The prompt file goes once read.
		expect(await readdir(scratch)).toEqual([]);
	});

	test("answers other instructions too, with the variety asked for", async () => {
		const { store } = await setup(false);
		const server = fakeServer("a richer prompt");
		const writer = new LocalTranslator({
			store,
			model: "qwen",
			spawn: server.spawn,
			fetch: server.fetch,
			freePort: async () => 4321,
		});
		expect(
			await writer.reply("Improve it.", "a fox", new AbortController().signal, {
				temperature: 0.7,
			}),
		).toBe("a richer prompt");
		expect(server.asked[0]).toMatchObject({
			messages: [
				{ role: "system", content: "Improve it." },
				{ role: "user", content: "a fox" },
			],
			temperature: 0.7,
		});
		writer.stop();
	});

	test("under WSL passes the variety to the one-off run", async () => {
		const { store } = await setup(true);
		const runs: string[][] = [];
		const run: RunOnce = async (argv) => {
			runs.push(argv);
			return { code: 0, stdout: "a richer prompt [end of text]", stderr: "" };
		};
		const writer = new LocalTranslator({
			store,
			model: "qwen",
			run,
			windowsPath: async (path) => path,
		});
		await writer.reply("Improve it.", "a fox", new AbortController().signal, {
			temperature: 0.7,
		});
		const args = runs[0] ?? [];
		expect(args[args.indexOf("--temp") + 1]).toBe("0.7");
	});

	test("says why when the model stops", async () => {
		const { store } = await setup(true);
		const translator = new LocalTranslator({
			store,
			model: "qwen",
			run: async () => ({
				code: 1,
				stdout: "",
				stderr: "loading model\nfailed to load model\n",
			}),
			windowsPath: async (path) => path,
		});
		await expect(
			translator.toEnglish("uma raposa", new AbortController().signal),
		).rejects.toThrow("failed to load model");
	});

	test("a server that died is started again for the next prompt", async () => {
		const { store } = await setup(false);
		const server = fakeServer();
		const translator = new LocalTranslator({
			store,
			model: "qwen",
			spawn: server.spawn,
			fetch: server.fetch,
			freePort: async () => 4321,
		});
		const signal = new AbortController().signal;
		await translator.toEnglish("uma raposa", signal);
		server.crash();
		await Bun.sleep(0);
		await translator.toEnglish("outra raposa", signal);
		expect(server.started).toHaveLength(2);
		translator.stop();
	});

	test("is not unloaded while a prompt is being translated", async () => {
		const { store } = await setup(false);
		const server = fakeServer();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const translator = new LocalTranslator({
			store,
			model: "qwen",
			spawn: server.spawn,
			fetch: async (url, init) => {
				// The second prompt takes its time.
				if (!url.endsWith("/health") && String(init?.body).includes("lenta")) {
					await held;
				}
				return server.fetch(url, init);
			},
			freePort: async () => 4321,
			idleMs: 20,
		});
		const signal = new AbortController().signal;
		await translator.toEnglish("primeira", signal);
		const slow = translator.toEnglish("lenta", signal);
		await translator.toEnglish("terceira", signal);
		// Longer than the idle time, with the slow one still under way.
		await Bun.sleep(60);
		expect(server.killed()).toBe(0);
		release();
		await slow;
		await Bun.sleep(60);
		expect(server.killed()).toBe(1);
	});

	test("stopping lets go of the model, waiting until its server has exited", async () => {
		const { store } = await setup(false);
		const server = fakeServer();
		const translator = new LocalTranslator({
			store,
			model: "qwen",
			spawn: server.spawn,
			fetch: server.fetch,
			freePort: async () => 4321,
		});
		await translator.toEnglish("uma raposa", new AbortController().signal);
		await translator.stopAndWait();
		expect(server.killed()).toBe(1);
	});

	test("is ready only once its model is installed", async () => {
		const { store } = await setup(false);
		expect(await new LocalTranslator({ store, model: "qwen" }).ready()).toBe(
			true,
		);
		expect(await new LocalTranslator({ store, model: "other" }).ready()).toBe(
			false,
		);
	});
});
