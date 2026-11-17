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
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const PORT = 4100;
const PROGRAM = "open-reel-preview.exe";
const root = join(import.meta.dir, "..");

if (!process.env.WSL_DISTRO_NAME) {
	console.error("This runs from WSL, to start open-reel on the Windows side.");
	process.exit(1);
}

const localAppData = (
	await $`cmd.exe /c echo %LOCALAPPDATA%`.quiet().text()
).trim();
const windowsDir = `${localAppData}\\open-reel\\preview`;
const dir = (await $`wslpath -u ${windowsDir}`.text()).trim();

// A running preview holds its program open, so it is stopped first.
await $`taskkill.exe /IM ${PROGRAM} /F`.quiet().nothrow();
if (process.argv.includes("--stop")) {
	console.log("Stopped.");
	process.exit(0);
}

// The installed app holds the same data directory while it is open.
const app = await $`tasklist.exe /FI "IMAGENAME eq open-reel-server.exe" /NH`
	.quiet()
	.nothrow()
	.text();
if (app.includes("open-reel-server.exe")) {
	console.error(
		"The open-reel app is open. Close it first: both use the same data.",
	);
	process.exit(1);
}

console.log("Building the interface…");
await $`bun run --filter @open-reel/web build`.cwd(root).quiet();

console.log("Compiling the server for Windows…");
await mkdir(dir, { recursive: true });
await $`bun build --compile --minify --target=bun-windows-x64 ${join(root, "packages/cli/src/index.ts")} --outfile ${join(dir, PROGRAM)}`.quiet();
await rm(join(dir, "resources"), { recursive: true, force: true });
await cp(join(root, "apps/web/dist"), join(dir, "resources/web"), {
	recursive: true,
});
await cp(join(root, "packages/core/drizzle"), join(dir, "resources/drizzle"), {
	recursive: true,
});

const program = `${windowsDir}\\${PROGRAM}`;
const log = `${windowsDir}\\preview.log`;
await $`powershell.exe -NoProfile -Command ${`Start-Process -WindowStyle Hidden -FilePath '${program}' -ArgumentList '--port ${PORT} --resources "${windowsDir}\\resources"' -RedirectStandardOutput '${log}' -RedirectStandardError '${log}.err'`}`;

// Up when its API answers; otherwise, show what it said.
const errors = (await $`wslpath -u ${`${log}.err`}`.text()).trim();
for (let i = 0; i < 40; i++) {
	await Bun.sleep(500);
	const up =
		await $`powershell.exe -NoProfile -Command ${`try { Invoke-RestMethod http://127.0.0.1:${PORT}/api/providers | Out-Null; 'up' } catch { 'down' }`}`
			.quiet()
			.text();
	if (up.includes("up")) {
		console.log(`open-reel is running on Windows: http://localhost:${PORT}`);
		console.log(`Its output: ${log}`);
		console.log("Stop it with: bun run preview:windows --stop");
		process.exit(0);
	}
	const said = await Bun.file(errors)
		.text()
		.catch(() => "");
	if (said.trim()) {
		console.error(`open-reel did not start: ${said.trim()}`);
		process.exit(1);
	}
}
console.error(`open-reel did not answer in 20 s. See ${log}`);
process.exit(1);
