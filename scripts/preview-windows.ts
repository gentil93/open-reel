/**
 * Runs the current code as a native Windows program, without building an
 * installer: for trying changes from WSL in seconds, with everything that only
 * works natively (such as keeping a local model loaded between pictures).
 *
 *   bun run preview:windows          build, start, and open the browser
 *   bun run preview:windows --stop   stop it
 *
 * It uses the same data as the installed app, so close the app first.
 */
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const PORT = 4100;
const PROGRAM = "hatchlight-preview.exe";
const root = join(import.meta.dir, "..");

if (!process.env.WSL_DISTRO_NAME) {
	console.error("This runs from WSL, to start Hatchlight on the Windows side.");
	process.exit(1);
}

const localAppData = (
	await $`cmd.exe /c echo %LOCALAPPDATA%`.quiet().text()
).trim();
const windowsDir = `${localAppData}\\hatchlight\\preview`;
const dir = (await $`wslpath -u ${windowsDir}`.text()).trim();

/**
 * Stops the preview's server: the one its data directory says is running,
 * with the engines it started (/T), since a model kept loaded would
 * otherwise outlive it. Only that one: agents may run this same program as
 * their MCP server, and those keep running.
 */
async function stopServer(): Promise<boolean> {
	const appData = (await $`cmd.exe /c echo %APPDATA%`.quiet().text()).trim();
	const file = (
		await $`wslpath -u ${`${appData}\\hatchlight\\hatchlight.server.json`}`.text()
	).trim();
	const pid = await Bun.file(file)
		.json()
		.then((info: { pid?: unknown }) => info.pid)
		.catch(() => null);
	if (typeof pid !== "number" || !Number.isInteger(pid)) return false;
	// The installed app writes the same file; only a preview is stopped.
	const listed = await $`tasklist.exe /FI ${`PID eq ${pid}`} /NH`
		.quiet()
		.nothrow()
		.text();
	if (!listed.includes(PROGRAM)) return false;
	await $`taskkill.exe /PID ${pid} /T /F`.quiet().nothrow();
	return true;
}

const stopped = await stopServer();
if (process.argv.includes("--stop")) {
	console.log(stopped ? "Stopped." : "No preview was running.");
	process.exit(0);
}

// The installed app holds the same data directory while it is open.
const app = await $`tasklist.exe /FI "IMAGENAME eq hatchlight-server.exe" /NH`
	.quiet()
	.nothrow()
	.text();
if (app.includes("hatchlight-server.exe")) {
	console.error(
		"The Hatchlight app is open. Close it first: both use the same data.",
	);
	process.exit(1);
}

const url = `http://localhost:${PORT}`;
console.log(`Starting Hatchlight on Windows, at ${url} once ready.`);

/**
 * Runs one step, saying what it does and, on a terminal, the seconds going
 * by, then how long it took: some steps take a minute, and silence looks
 * like a hang.
 */
async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
	const started = Date.now();
	const seconds = () => Math.round((Date.now() - started) / 1000);
	const live = process.stdout.isTTY;
	if (!live) console.log(`${what}…`);
	const ticker = live
		? setInterval(() => process.stdout.write(`\r${what}… ${seconds()}s`), 250)
		: undefined;
	try {
		const result = await run();
		clearInterval(ticker);
		if (live) process.stdout.write(`\r${what}… done in ${seconds()}s\n`);
		else console.log(`  done in ${seconds()}s`);
		return result;
	} catch (error) {
		clearInterval(ticker);
		if (live) process.stdout.write("\n");
		// What the command said, not where in this script it was run from.
		const said =
			(error as { stderr?: { toString(): string } }).stderr
				?.toString()
				.trim() || (error instanceof Error ? error.message : String(error));
		console.error(`${what} failed:\n${said}`);
		process.exit(1);
	}
}

// A pull may bring a new package: without this the build cannot find it.
await step("Installing dependencies", () =>
	$`bun install --frozen-lockfile`.cwd(root).quiet(),
);

await step("Building the interface", () =>
	$`bun run --filter @hatchlight/web build`.cwd(root).quiet(),
);

await step("Compiling the server for Windows", async () => {
	await mkdir(dir, { recursive: true });
	// Agents may be running the program as their MCP server: Windows keeps
	// it from being replaced, but lets it be renamed. Old copies go once
	// nothing runs them.
	for (const name of await readdir(dir)) {
		if (name.startsWith(`${PROGRAM}.old-`)) {
			await rm(join(dir, name), { force: true }).catch(() => {});
		}
	}
	await rename(
		join(dir, PROGRAM),
		join(dir, `${PROGRAM}.old-${Date.now()}`),
	).catch(() => {});
	await $`bun build --compile --minify --target=bun-windows-x64 ${join(root, "packages/cli/src/index.ts")} --outfile ${join(dir, PROGRAM)}`.quiet();
	await rm(join(dir, "resources"), { recursive: true, force: true });
	await cp(join(root, "apps/web/dist"), join(dir, "resources/web"), {
		recursive: true,
	});
	await cp(
		join(root, "packages/core/drizzle"),
		join(dir, "resources/drizzle"),
		{
			recursive: true,
		},
	);
});

const program = `${windowsDir}\\${PROGRAM}`;
const log = `${windowsDir}\\preview.log`;
const errors = (await $`wslpath -u ${`${log}.err`}`.text()).trim();
await rm(errors, { force: true });

await step("Starting it", async () => {
	// Created by Windows' management service, so it inherits nothing from
	// this command. Through WSL, a program that inherits the connections WSL
	// talks to Windows with (Start-Process with redirected output does) keeps
	// the command from returning until it exits, which a server never does.
	const command = `cmd.exe /c ""${program}" --port ${PORT} --resources "${windowsDir}\\resources" > "${log}" 2> "${log}.err""`;
	// In PowerShell's single quotes, a quote is written twice (O'Brien).
	const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;
	const start = Bun.spawn(
		[
			"powershell.exe",
			"-NoProfile",
			"-Command",
			`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quoted(command)}; CurrentDirectory = ${quoted(windowsDir)} }; if ($r -eq $null) { exit 1 }; exit $r.ReturnValue`,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
	);
	if ((await start.exited) !== 0) {
		const said = await new Response(start.stderr).text();
		throw new Error(`Windows would not start it. ${said.trim()}`);
	}
});

// Up when its API answers; otherwise, show what it said. Asked from the
// Windows side: under WSL, Windows' localhost cannot be reached from Linux.
const answered = await step("Waiting for it to answer", async () => {
	const started = Date.now();
	while (Date.now() - started < 60_000) {
		const up =
			await $`powershell.exe -NoProfile -Command ${`try { Invoke-RestMethod http://127.0.0.1:${PORT}/api/providers | Out-Null; 'up' } catch { 'down' }`}`
				.quiet()
				.nothrow()
				.text();
		if (up.includes("up")) return true;
		// What it said counts only if it is gone: a warning is not a failure.
		const running = await $`tasklist.exe /FI ${`IMAGENAME eq ${PROGRAM}`} /NH`
			.quiet()
			.nothrow()
			.text();
		if (!running.includes(PROGRAM)) {
			const said = await Bun.file(errors)
				.text()
				.catch(() => "");
			console.error(
				`\nHatchlight stopped as it started${said.trim() ? `: ${said.trim()}` : `. See ${log}`}`,
			);
			process.exit(1);
		}
		await Bun.sleep(500);
	}
	return false;
});
if (!answered) {
	console.error(`Hatchlight did not answer in a minute. See ${log}`);
	process.exit(1);
}
console.log(`\nHatchlight is running on Windows: ${url}`);
console.log(`Its output: ${log}`);
console.log("Stop it with: bun run preview:windows --stop");
process.exit(0);
