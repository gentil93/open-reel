#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultDataDir, defaultModelsDir } from "@open-reel/core";
import {
	createApp,
	createRuntime,
	DataDirInUseError,
	serveWeb,
} from "@open-reel/server";

const HELP = `open-reel — one interface for many image generation models

Usage: open-reel [options]

  --port <n>       Port to listen on (default 4096)
  --data-dir <p>   Where sessions, images and keys are stored
                   (default ${defaultDataDir()})
  --dev            Accept requests from the Vite dev server and skip the UI
  --no-open        Do not open the browser
  -h, --help       Show this help
`;

const { values } = parseArgs({
	options: {
		port: { type: "string", default: "4096" },
		"data-dir": { type: "string" },
		dev: { type: "boolean", default: false },
		"no-open": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (values.help) {
	console.log(HELP);
	process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	console.error(`Invalid port: ${values.port}`);
	process.exit(1);
}

const WEB_DIST = join(import.meta.dir, "..", "..", "..", "apps", "web", "dist");
const dataDir = values["data-dir"] ?? defaultDataDir();
// An explicit data directory keeps everything, models included, inside it.
const modelsDir = values["data-dir"]
	? join(dataDir, "models")
	: await defaultModelsDir(dataDir);
const runtime = await createRuntime({ dataDir, modelsDir }).catch((error) => {
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
console.log(`open-reel is running at ${url}`);
console.log(`Data directory: ${dataDir}`);
if (modelsDir !== join(dataDir, "models")) {
	console.log(`Local models: ${modelsDir}`);
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.stop(true);
		runtime.close();
		process.exit(0);
	});
}
