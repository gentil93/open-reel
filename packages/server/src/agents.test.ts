import { afterEach, expect, test } from "bun:test";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	Agents,
	type AgentsSetup,
	agentsSetup,
	storeFolder,
	wslPath,
} from "./agents";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function temp() {
	const dir = await mkdtemp(join(tmpdir(), "open-reel-agents-"));
	dirs.push(dir);
	return dir;
}

async function claude(installed = true) {
	const home = await temp();
	const folder = join(home, "Claude");
	if (installed) await mkdir(folder);
	const config = join(folder, "claude_desktop_config.json");
	const setup: AgentsSetup = {
		code: {
			command: "/usr/bin/bun",
			args: ["/src/cli.ts", "mcp"],
			env: { OPEN_REEL_MODELS_DIR: "/models" },
		},
		desktop: { command: "wsl.exe", args: ["-d", "Ubuntu", "-e", "bun"] },
		claudeDesktopConfig: config,
		shell: "posix",
	};
	const read = async () => JSON.parse(await readFile(config, "utf8"));
	return { agents: new Agents(async () => setup), config, folder, read };
}

test("Claude Desktop gets open-reel next to what it already had", async () => {
	const { agents, config, read } = await claude();
	await writeFile(
		config,
		`\uFEFF${JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other" } } })}`,
	);
	expect((await agents.status()).claudeDesktop).toEqual({
		available: true,
		connected: false,
		current: false,
		policy: null,
		problem: null,
	});

	await agents.connectClaudeDesktop({ allowPaid: false, spendLimitUsd: null });
	expect(await read()).toEqual({
		theme: "dark",
		mcpServers: {
			other: { command: "other" },
			"open-reel": { command: "wsl.exe", args: ["-d", "Ubuntu", "-e", "bun"] },
		},
	});
	// What was there before open-reel is kept beside it.
	expect(await readFile(`${config}.before-open-reel`, "utf8")).toContain(
		'"theme":"dark"',
	);

	await agents.connectClaudeDesktop({ allowPaid: true, spendLimitUsd: 5 });
	expect((await read()).mcpServers["open-reel"].args.slice(-3)).toEqual([
		"--allow-paid",
		"--spend-limit",
		"5",
	]);
	expect((await agents.status()).claudeDesktop).toMatchObject({
		connected: true,
		current: true,
		policy: { allowPaid: true, spendLimitUsd: 5 },
	});

	await agents.disconnectClaudeDesktop();
	expect(await read()).toEqual({
		theme: "dark",
		mcpServers: { other: { command: "other" } },
	});
});

test("settings that cannot be read are left alone, and the reason is shown", async () => {
	const { agents, config } = await claude();
	await writeFile(config, "{ not json");
	await expect(
		agents.connectClaudeDesktop({ allowPaid: false, spendLimitUsd: null }),
	).rejects.toMatchObject({ code: "claudeConfigUnreadable" });
	expect(await readFile(config, "utf8")).toBe("{ not json");

	// Not a missing file: something there that cannot be read as one.
	await rm(config);
	await mkdir(config);
	await expect(
		agents.connectClaudeDesktop({ allowPaid: false, spendLimitUsd: null }),
	).rejects.toMatchObject({ code: "claudeConfigUnreadable" });
	expect((await agents.status()).claudeDesktop.problem).toContain(
		"cannot be read",
	);

	await rm(config, { recursive: true });
	await writeFile(config, JSON.stringify({ mcpServers: ["odd"] }));
	await expect(
		agents.connectClaudeDesktop({ allowPaid: false, spendLimitUsd: null }),
	).rejects.toMatchObject({ code: "claudeConfigUnreadable" });
});

test("the settings keep their permissions, and a link stays a link", async () => {
	const { agents, folder } = await claude();
	const real = join(folder, "real.json");
	const config = join(folder, "claude_desktop_config.json");
	await writeFile(real, "{}");
	await chmod(real, 0o600);
	await symlink(real, config);
	await agents.connectClaudeDesktop({ allowPaid: false, spendLimitUsd: null });
	expect((await stat(real)).mode & 0o777).toBe(0o600);
	expect(JSON.parse(await readFile(real, "utf8")).mcpServers).toHaveProperty(
		"open-reel",
	);
	expect((await lstat(config)).isSymbolicLink()).toBe(true);
});

test("without Claude Desktop, nothing is written and the reason is said", async () => {
	const { agents, config } = await claude(false);
	expect((await agents.status()).claudeDesktop.available).toBe(false);
	await expect(
		agents.connectClaudeDesktop({ allowPaid: false, spendLimitUsd: null }),
	).rejects.toMatchObject({ code: "claudeNotFound" });
	expect(Bun.file(config).exists()).resolves.toBe(false);
});

test("Claude Code gets a command to run, keeping where models are", async () => {
	const { agents } = await claude();
	expect((await agents.status()).claudeCode).toEqual([
		"claude",
		"mcp",
		"add",
		"open-reel",
		"--scope",
		"user",
		"-e",
		"OPEN_REEL_MODELS_DIR=/models",
		"--",
		"/usr/bin/bun",
		"/src/cli.ts",
		"mcp",
	]);
});

test("each system's Claude Desktop settings are found where it keeps them", async () => {
	const windows = await agentsSetup({
		platform: "win32",
		env: {
			APPDATA: "C:\\Users\\a\\AppData\\Roaming\\",
			LOCALAPPDATA: "C:\\nowhere",
		},
	});
	expect(windows.claudeDesktopConfig).toBe(
		"C:\\Users\\a\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
	);
	expect(windows.shell).toBe("powershell");
	const mac = await agentsSetup({
		platform: "darwin",
		env: {},
		home: "/Users/a",
	});
	expect(mac.claudeDesktopConfig).toBe(
		"/Users/a/Library/Application Support/Claude/claude_desktop_config.json",
	);
	const linux = await agentsSetup({
		platform: "linux",
		env: { OPEN_REEL_MODELS_DIR: "models" },
		home: "/home/a",
		dataDir: "./data",
	});
	expect(linux.claudeDesktopConfig).toBe(
		"/home/a/.config/Claude/claude_desktop_config.json",
	);
	// Agents start it from elsewhere: paths are whole.
	expect(linux.code.args.slice(-3)).toEqual([
		"mcp",
		"--data-dir",
		resolve("./data"),
	]);
	expect(linux.code.env).toEqual({ OPEN_REEL_MODELS_DIR: resolve("models") });
	expect(linux.desktop).toEqual(linux.code);
});

test("Claude from the Microsoft Store is set up in its own package", async () => {
	const local = await temp();
	expect(await storeFolder(local, join)).toBeNull();
	const used = join(
		local,
		"Packages",
		"Claude_abc",
		"LocalCache",
		"Roaming",
		"Claude",
	);
	await mkdir(join(local, "Packages", "Claude_old"), { recursive: true });
	await mkdir(used, { recursive: true });
	expect(await storeFolder(local, join)).toBe(used);
});

test("a Windows installation is offered to Claude Code inside WSL too", async () => {
	expect(wslPath("C:\\Users\\a\\open-reel.exe")).toBe(
		"/mnt/c/Users/a/open-reel.exe",
	);
	expect(wslPath("\\\\server\\share\\open-reel.exe")).toBeNull();
	const windows = await agentsSetup({
		platform: "win32",
		env: {
			APPDATA: "C:\\Users\\a\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\nowhere",
			OPEN_REEL_MODELS_DIR: "D:\\models",
		},
		program: "C:\\Program Files\\open-reel\\open-reel.exe",
	});
	expect(windows.codeInWsl?.command).toBe(
		"/mnt/c/Program Files/open-reel/open-reel.exe",
	);
	// Its arguments and settings stay Windows paths: the Windows program reads them.
	expect(windows.codeInWsl?.args).toEqual(windows.code.args);
	expect(windows.codeInWsl?.env?.WSLENV).toBe("OPEN_REEL_MODELS_DIR");
	const share = await agentsSetup({
		platform: "win32",
		env: { APPDATA: "C:\\a", LOCALAPPDATA: "C:\\b" },
		program: "\\\\server\\share\\open-reel.exe",
	});
	expect(share.codeInWsl).toBeUndefined();
});
