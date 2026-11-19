/**
 * Renames the project from its old name, open-reel, to Hatchlight, in every
 * file git tracks:
 *
 *   bun scripts/rename-to-hatchlight.ts
 *
 * Deterministic and idempotent: a second run changes nothing, and a run on a
 * newer main renames whatever was added there the same way. Run `bun install`
 * afterwards so bun.lock follows the workspace names.
 *
 * The old name is written as a slug (a folder, a file, a package, a command)
 * or as a name in sentences. Slugs become `hatchlight`, names `Hatchlight`.
 * Files in KEEP hold the old name on purpose, so existing installs keep
 * working, and are left alone.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");

/** Files that refer to the old name on purpose. */
const KEEP = new Set([
	"scripts/rename-to-hatchlight.ts",
	"packages/core/src/legacy.ts",
]);

/** Files that are not text. */
const BINARY = /\.(png|jpe?g|webp|gif|ico|icns|woff2?|ttf|otf|mp4|webm|zip)$/i;

/** Replacements that come first, whole: addresses and fixed names. */
const EXACT: [RegExp, string][] = [
	[/https:\/\/gentil93\.github\.io\/open-reel\//g, "https://hatchlight.app/"],
	[
		/https:\/\/github\.com\/gentil93\/open-reel/g,
		"https://github.com/hatchlight/hatchlight",
	],
	[/org\.openreel\.desktop/g, "app.hatchlight.desktop"],
	[/OPEN_REEL/g, "HATCHLIGHT"],
	[/OpenReel/g, "Hatchlight"],
	[/openReel/g, "hatchlight"],
	[/open_reel/g, "hatchlight"],
	// Said by the server and read by the desktop app and the MCP server.
	[/open-reel is running at/g, "Hatchlight is running at"],
	// Names people read, where the generic rule below would see a slug.
	[/"productName": "open-reel"/g, '"productName": "Hatchlight"'],
	[/\.title\("open-reel"\)/g, '.title("Hatchlight")'],
	[/content="open-reel"/g, 'content="Hatchlight"'],
	[/\bcd open-reel\b/g, "cd hatchlight"],
	[/\ban open-reel\b/g, "a open-reel"],
	[/\bAn open-reel\b/g, "A open-reel"],
];

/**
 * Whether the old name at `at` in `text` is a slug: part of a path, a file
 * name, a package or a command, or a whole quoted string.
 */
function isSlug(text: string, at: number, length: number): boolean {
	const before = text[at - 1] ?? "";
	const after = text.slice(at + length);
	if (/[@/\\._-]/.test(before)) return true;
	return (
		/^[-/\\@=]/.test(after) ||
		/^\.[A-Za-z0-9]/.test(after) ||
		(/["'`]/.test(before) && /^["'`]/.test(after)) ||
		/^ (mcp\b|\[|--)/.test(after)
	);
}

/** Text elsewhere that names the old name on purpose, kept as it is. */
const KEEP_TEXT = [
	// README.md
	"keep using their `open-reel` folders and `OPEN_REEL_*` variables.",
	// apps/desktop/src-tauri/src/update.rs
	'const LEGACY_ENV_NAME: &str = "OPEN_REEL";',
];

/** `text` with the old name replaced. */
export function renameText(text: string): string {
	const keep = new RegExp(
		KEEP_TEXT.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
		"g",
	);
	const kept = text.match(keep) ?? [];
	return text
		.split(keep)
		.map(renamePart)
		.reduce((out, part, i) => out + kept[i - 1] + part);
}

function renamePart(text: string): string {
	let out = text;
	for (const [pattern, replacement] of EXACT) {
		out = out.replace(pattern, replacement);
	}
	return out.replace(/open-reel/g, (match, at: number, whole: string) =>
		isSlug(whole, at, match.length) ? "hatchlight" : "Hatchlight",
	);
}

/** A path with the old name replaced; paths only hold slugs. */
export function renamePath(path: string): string {
	return path
		.replace(/open-reel/g, "hatchlight")
		.replace(/OpenReel/g, "Hatchlight")
		.replace(/openReel/g, "hatchlight");
}

if (import.meta.main) {
	const files = (await $`git ls-files -z`.cwd(root).text())
		.split("\0")
		.filter(Boolean);
	const changed: string[] = [];
	for (const file of files) {
		if (KEEP.has(file) || BINARY.test(file)) continue;
		const path = join(root, file);
		const before = await readFile(path, "utf8").catch(() => null);
		if (before === null || before.includes("\0")) continue;
		const after = renameText(before);
		if (after !== before) await writeFile(path, after);
		const moved = renamePath(file);
		if (moved !== file) {
			await mkdir(dirname(join(root, moved)), { recursive: true });
			await rename(path, join(root, moved));
		}
		if (after !== before || moved !== file) changed.push(moved);
	}
	// Names of another length move line breaks, table columns and the order
	// of imports: the formatter puts them back as the repository has them.
	if (changed.length > 0) {
		await $`bun x biome check --write --no-errors-on-unmatched --files-ignore-unknown=true ${changed}`
			.cwd(root)
			.quiet()
			.nothrow();
	}
	console.log(`Renamed to Hatchlight: ${changed.length} file(s) changed.`);
}
