/**
 * Compiles the open-reel server into one executable for the desktop app to
 * run, and gathers what it reads from disk: the built UI and the migrations.
 * Tauri looks for the executable under the target's name, so it is built for
 * the target Tauri is building for (or this machine's).
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..", "..", "..");
const tauri = join(import.meta.dir, "..", "src-tauri");

/** Rust target triples, and the Bun target that runs on each. */
const BUN_TARGETS: Record<string, string> = {
	"x86_64-unknown-linux-gnu": "bun-linux-x64",
	"aarch64-unknown-linux-gnu": "bun-linux-arm64",
	"x86_64-pc-windows-msvc": "bun-windows-x64",
	"x86_64-apple-darwin": "bun-darwin-x64",
	"aarch64-apple-darwin": "bun-darwin-arm64",
};

async function targetTriple(): Promise<string> {
	const fromTauri = process.env.TAURI_ENV_TARGET_TRIPLE;
	if (fromTauri) return fromTauri;
	const info = await $`rustc -vV`.text();
	const host = info.match(/^host: (\S+)$/m)?.[1];
	if (!host) throw new Error("Could not tell this machine's target from rustc");
	return host;
}

const triple = await targetTriple();
const bunTarget = BUN_TARGETS[triple];
if (!bunTarget) throw new Error(`No Bun build for ${triple}`);
const extension = triple.includes("windows") ? ".exe" : "";
const outfile = join(
	tauri,
	"binaries",
	`open-reel-server-${triple}${extension}`,
);

await mkdir(join(tauri, "binaries"), { recursive: true });
await $`bun build --compile --minify --target=${bunTarget} ${join(root, "packages", "cli", "src", "index.ts")} --outfile ${outfile}`;

const resources = join(tauri, "resources");
await rm(resources, { recursive: true, force: true });
await cp(join(root, "apps", "web", "dist"), join(resources, "web"), {
	recursive: true,
});
await cp(
	join(root, "packages", "core", "drizzle"),
	join(resources, "drizzle"),
	{
		recursive: true,
	},
);
console.log(`Server for ${triple}: ${outfile}`);
