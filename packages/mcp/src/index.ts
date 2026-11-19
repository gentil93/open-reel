import { readServerInfo } from "@hatchlight/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HatchlightClient } from "./client";
import { createMcpServer, type McpOptions } from "./tools";

export { HatchlightClient, ServerError } from "./client";
export { createMcpServer, type McpOptions } from "./tools";

/** How long a server started for the agent may take to come up. */
const START_TIMEOUT_MS = 60_000;
/** How long an app that is starting may take to say where it listens. */
const STARTING_APP_MS = 20_000;

/** The server at `url`, if it answers soon and like Hatchlight. */
async function answers(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/api/models`, {
			signal: AbortSignal.timeout(3000),
		});
		return response.ok && Array.isArray(await response.json());
	} catch {
		return false;
	}
}

/** The server running on a data directory, if it answers. */
async function running(dataDir: string): Promise<string | null> {
	const info = await readServerInfo(dataDir);
	return info && (await answers(info.url)) ? info.url : null;
}

/** Starts a server that lives as long as this process; null if one runs. */
async function start(
	launcher: string[],
	serverArgs: string[],
): Promise<string | "in use"> {
	const child = Bun.spawn(
		[
			...launcher,
			...serverArgs,
			"--port",
			"0",
			"--no-open",
			"--parent-pid",
			String(process.pid),
		],
		// Its input stays open: closing it is how it is told to stop. Its
		// output must not reach ours, which carries the protocol.
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	// Read from the start, so the server never blocks on a full pipe.
	const errors = new Response(child.stderr).text();
	const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
	let seen = "";
	const timeout = setTimeout(() => child.kill(), START_TIMEOUT_MS);
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += value;
			// A whole line: the address may come in pieces.
			const found = seen.match(/Hatchlight is running at (http:\/\/\S+)\r?\n/);
			if (found?.[1]) {
				void (async () => {
					while (!(await reader.read()).done) {}
				})();
				return found[1].replace("localhost", "127.0.0.1");
			}
		}
	} finally {
		clearTimeout(timeout);
	}
	const reason = (await errors).trim();
	if (/already running/.test(reason)) return "in use";
	throw new Error(`Hatchlight did not start: ${reason || seen.trim()}`);
}

/**
 * The Hatchlight server for a data directory: the one already running, or
 * one started for this process, which stops when it does.
 */
async function connect(
	dataDir: string,
	launcher: string[],
	serverArgs: string[],
): Promise<string> {
	const url = (await running(dataDir)) ?? (await start(launcher, serverArgs));
	if (url !== "in use") return url;
	// The app holds the directory but is still starting: it will say where
	// it listens in a moment.
	const until = Date.now() + STARTING_APP_MS;
	while (Date.now() < until) {
		await Bun.sleep(250);
		const found = await running(dataDir);
		if (found) return found;
	}
	throw new Error(
		"Hatchlight is running on this data directory but does not answer",
	);
}

export interface RunOptions extends McpOptions {
	dataDir: string;
	/** The program, and its script if any, that starts a Hatchlight server. */
	launcher: string[];
	/** Options the server is started with, such as its data directory. */
	serverArgs: string[];
}

/**
 * Serves the tools on standard input and output, for an agent to use, until
 * the agent closes them.
 */
export async function runMcp(options: RunOptions): Promise<void> {
	const url = await connect(
		options.dataDir,
		options.launcher,
		options.serverArgs,
	);
	const server = createMcpServer(new HatchlightClient(url), options);
	// The agent leaves by closing our input, which the transport does not
	// report: either way, this process ends, and a server it started with it.
	const closed = new Promise<void>((done) => {
		server.server.onclose = done;
		process.stdin.once("end", done);
		process.stdin.once("close", done);
	});
	await server.connect(new StdioServerTransport());
	await closed;
}
