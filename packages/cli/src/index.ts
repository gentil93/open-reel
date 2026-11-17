#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultDataDir, defaultModelsDir, plainPath } from "@open-reel/core";
import {
	createApp,
	createRuntime,
	DataDirInUseError,
	serveWeb,
} from "@open-reel/server";

const HELP = `open-reel — one interface for many image generation models

Usage: open-reel [options]

  --port <n>       Port to listen on (default 4096; 0 picks a free one)
  --data-dir <p>   Where sessions, images and keys are stored
                   (default ${defaultDataDir()})
  --dev            Accept requests from the Vite dev server and skip the UI
  --no-open        Do not open the browser
  --resources <p>  Where a packaged app keeps the built UI (web/) and the
                   database migrations (drizzle/)
  --parent-pid <n> Stop when the process with this id ends, such as the
                   desktop app that started this server, or when it closes
                   this server's standard input
  -h, --help       Show this help
`;

const { values } = parseArgs({
	options: {
		port: { type: "string", default: "4096" },
		"data-dir": { type: "string" },
		dev: { type: "boolean", default: false },
		"no-open": { type: "boolean", default: false },
		resources: { type: "string" },
		"parent-pid": { type: "string" },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (values.help) {
	console.log(HELP);
	process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	console.error(`Invalid port: ${values.port}`);
	process.exit(1);
}

const parentPid =
	values["parent-pid"] == null ? null : Number(values["parent-pid"]);
if (parentPid != null && !(Number.isInteger(parentPid) && parentPid > 0)) {
	console.error(`Invalid parent process id: ${values["parent-pid"]}`);
	process.exit(1);
}

const resources = values.resources ? plainPath(values.resources) : undefined;

// A compiled binary has no source tree around it, so it is told where things are.
const WEB_DIST = resources
	? join(resources, "web")
	: join(import.meta.dir, "..", "..", "..", "apps", "web", "dist");
const migrationsDir = resources ? join(resources, "drizzle") : undefined;
const dataDir = values["data-dir"] ?? defaultDataDir();
// An explicit data directory keeps everything inside it, models included,
// unless OPEN_REEL_MODELS_DIR names another place for them.
const modelsDir =
	process.env.OPEN_REEL_MODELS_DIR ??
	(values["data-dir"]
		? join(dataDir, "models")
		: await defaultModelsDir(dataDir));
const runtime = await createRuntime({
	dataDir,
	modelsDir,
	migrationsDir,
}).catch((error) => {
	if (!(error instanceof DataDirInUseError)) throw error;
	console.error(`${error.message}.`);
	process.exit(1);
});
const app = createApp({
	...runtime,
	allowedOrigins: values.dev ? ["http://localhost:5173"] : [],
});

if (!values.dev) {
	if (!(await Bun.file(join(WEB_DIST, "index.html")).exists())) {
		console.error("The web UI is not built. Run `bun run build` first.");
		runtime.close();
		process.exit(1);
	}
	serveWeb(app, WEB_DIST);
}

// Loopback only: the server holds API keys and has no login.
function listen() {
	try {
		return Bun.serve({
			hostname: "127.0.0.1",
			port,
			idleTimeout: 0, // the event stream stays open
			fetch: app.fetch,
		});
	} catch (error) {
		if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
		console.error(
			`Port ${port} is already in use. Choose another with --port.`,
		);
		runtime.close();
		process.exit(1);
	}
}
const server = listen();
// Only now that this process owns the port and the data directory.
await runtime.start();
const url = `http://localhost:${server.port}`;
// Written straight to the descriptor, so the line is out at once: the
// desktop app waits for it before opening the window on this address.
const say = (line: string) => writeSync(1, `${line}\n`);
say(`open-reel is running at ${url}`);
say(`Data directory: ${dataDir}`);
if (modelsDir !== join(dataDir, "models")) {
	say(`Local models: ${modelsDir}`);
}

if (!values.dev && !values["no-open"]) {
	const opener =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "explorer"
				: "xdg-open";
	try {
		Bun.spawn([opener, url], { stdio: ["ignore", "ignore", "ignore"] });
	} catch {
		// No browser launcher available; the URL is printed above.
	}
}

function shutdown(): never {
	server.stop(true);
	runtime.close();
	process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, shutdown);
}

// The desktop app stops this server by closing its input, which lets it shut
// down cleanly on every system. If the app dies instead, the server must not
// linger holding the data directory and the port.
if (parentPid != null) {
	void (async () => {
		for await (const _ of Bun.stdin.stream()) {
			// Nothing is sent; only the end matters.
		}
		shutdown();
	})();
	setInterval(() => {
		try {
			process.kill(parentPid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") shutdown();
		}
	}, 2000);
}
