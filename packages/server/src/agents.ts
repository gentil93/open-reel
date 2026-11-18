import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ValidationError } from "@open-reel/core";

/** How a program starts `open-reel mcp`. */
export interface Launch {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/** What the app knows about connecting agents to this installation. */
export interface AgentsSetup {
	/** As Claude Desktop starts it, e.g. through wsl.exe under WSL. */
	desktop: Launch;
	/** As an agent on this same system, such as Claude Code, starts it. */
	code: Launch;
	/** Where Claude Desktop keeps its settings, or null if unknown here. */
	claudeDesktopConfig: string | null;
	/** The shell the Claude Code command is written for. */
	shell: "posix" | "powershell";
}

/** What an agent may spend, as the person chose it. */
export interface AgentPolicy {
	allowPaid: boolean;
	spendLimitUsd: number | null;
}

export interface AgentsStatus {
	/** `claude mcp add …`, without the policy's options. */
	claudeCode: string[];
	/** The shell those words are for, to quote them. */
	shell: "posix" | "powershell";
	claudeDesktop: {
		/** Claude Desktop seems installed: its settings folder is there. */
		available: boolean;
		connected: boolean;
		/** The entry starts this installation as it is now. */
		current: boolean;
		policy: AgentPolicy | null;
		/** Why its settings could not be read, when they could not. */
		problem: string | null;
	};
}

/** The name open-reel goes by in agents' settings. */
const NAME = "open-reel";

/** The options `open-reel mcp` takes for a policy. */
export function policyArgs(policy: AgentPolicy): string[] {
	if (!policy.allowPaid) return [];
	return [
		"--allow-paid",
		...(policy.spendLimitUsd != null
			? ["--spend-limit", String(policy.spendLimitUsd)]
			: []),
	];
}

/** The policy an entry's options say, back. */
function policyOf(args: string[]): AgentPolicy {
	const at = args.indexOf("--spend-limit");
	const given = at >= 0 ? (args[at + 1] ?? "") : "";
	const limit = /^\d+(\.\d+)?$/.test(given) ? Number(given) : null;
	return { allowPaid: args.includes("--allow-paid"), spendLimitUsd: limit };
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

type Config = { mcpServers?: Record<string, unknown> } & Record<
	string,
	unknown
>;

const unreadable = (path: string) =>
	new ValidationError(
		"Claude Desktop's settings file cannot be read, so it is left as it is",
		"claudeConfigUnreadable",
		{ path },
	);

/**
 * Claude Desktop's settings, kept as they are. Missing, they are empty;
 * anything else unreadable is refused, never written over.
 */
async function readConfig(path: string): Promise<Config> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw unreadable(path);
	}
	const text = raw.replace(/^﻿/, "");
	if (!text.trim()) return {};
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch {
		throw unreadable(path);
	}
	const servers = (config as Config | null)?.mcpServers;
	if (
		!config ||
		typeof config !== "object" ||
		Array.isArray(config) ||
		(servers != null && (typeof servers !== "object" || Array.isArray(servers)))
	) {
		throw unreadable(path);
	}
	return config as Config;
}

/**
 * Writes the settings whole or not at all, through a link if it is one,
 * keeping the file's permissions: it often holds other servers' keys. The
 * first time, what was there is kept beside it.
 */
async function writeConfig(path: string, config: Config): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const target = await realpath(path).catch(() => path);
	const before = await stat(target).catch(() => null);
	const backup = `${target}.before-open-reel`;
	if (before && !(await exists(backup))) await copyFile(target, backup);
	const tmp = `${target}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, {
			mode: before ? before.mode & 0o777 : 0o600,
		});
		await rename(tmp, target);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}

/** Connects agents to open-reel, in their own settings. */
export class Agents {
	private setup: Promise<AgentsSetup> | null = null;
	/** Changes to the settings, one at a time. */
	private queue: Promise<unknown> = Promise.resolve();

	/** The setup is worked out when first needed: it may ask Windows. */
	constructor(private load: () => Promise<AgentsSetup>) {}

	private get(): Promise<AgentsSetup> {
		this.setup ??= this.load();
		return this.setup;
	}

	async status(): Promise<AgentsStatus> {
		const {
			code,
			desktop,
			shell,
			claudeDesktopConfig: path,
		} = await this.get();
		const env = Object.entries(code.env ?? {}).flatMap(([key, value]) => [
			"-e",
			`${key}=${value}`,
		]);
		const claudeCode = [
			"claude",
			"mcp",
			"add",
			NAME,
			"--scope",
			"user",
			...env,
			"--",
			code.command,
			...code.args,
		];
		const none = {
			available: false,
			connected: false,
			current: false,
			policy: null,
			problem: null,
		};
		if (!path || !(await exists(dirname(path)))) {
			return { claudeCode, shell, claudeDesktop: none };
		}
		let config: Config;
		try {
			config = await readConfig(path);
		} catch (error) {
			return {
				claudeCode,
				shell,
				claudeDesktop: {
					...none,
					available: true,
					problem: (error as Error).message,
				},
			};
		}
		const entry = config.mcpServers?.[NAME] as
			| { command?: unknown; args?: unknown }
			| undefined;
		const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
		return {
			claudeCode,
			shell,
			claudeDesktop: {
				available: true,
				connected: entry != null,
				current:
					entry?.command === desktop.command &&
					desktop.args.every((arg, i) => args[i] === arg),
				policy: entry ? policyOf(args) : null,
				problem: null,
			},
		};
	}

	/** Adds open-reel to Claude Desktop, or updates what it may spend. */
	connectClaudeDesktop(policy: AgentPolicy): Promise<void> {
		return this.change(async (config, { desktop }) => {
			config.mcpServers = {
				...(config.mcpServers ?? {}),
				[NAME]: {
					command: desktop.command,
					args: [...desktop.args, ...policyArgs(policy)],
					...(desktop.env &&
						Object.keys(desktop.env).length > 0 && { env: desktop.env }),
				},
			};
			return true;
		});
	}

	disconnectClaudeDesktop(): Promise<void> {
		return this.change(async (config) => {
			if (!config.mcpServers?.[NAME]) return false;
			const { [NAME]: _, ...rest } = config.mcpServers;
			config.mcpServers = rest;
			return true;
		});
	}

	/** Reads, changes and writes the settings, after any change before. */
	private change(
		edit: (config: Config, setup: AgentsSetup) => Promise<boolean>,
	): Promise<void> {
		const run = async () => {
			const setup = await this.get();
			const path = setup.claudeDesktopConfig;
			if (!path || !(await exists(dirname(path)))) {
				throw new ValidationError(
					"Claude Desktop is not installed on this computer",
					"claudeNotFound",
				);
			}
			const config = await readConfig(path);
			if (await edit(config, setup)) await writeConfig(path, config);
		};
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => {});
		return next;
	}
}

/** A program's output, or null if it fails or takes more than a moment. */
async function output(argv: string[]): Promise<string | null> {
	try {
		const child = Bun.spawn(argv, {
			cwd: "/",
			stdout: "pipe",
			stderr: "ignore",
		});
		const timer = setTimeout(() => child.kill(), 5000);
		const [text, code] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		clearTimeout(timer);
		return code === 0 ? text.replaceAll("\r", "").trim() : null;
	} catch {
		return null;
	}
}

const CONFIG_FILE = "claude_desktop_config.json";

/**
 * Claude from the Microsoft Store may keep its settings inside its
 * package; that folder is the one it uses when it is there.
 */
export async function storeFolder(
	localAppData: string,
	join: (...parts: string[]) => string,
): Promise<string | null> {
	const packages = join(localAppData, "Packages");
	const names = await readdir(packages).catch(() => [] as string[]);
	for (const name of names.filter((n) => n.startsWith("Claude_"))) {
		const folder = join(packages, name, "LocalCache", "Roaming", "Claude");
		if (await exists(folder)) return folder;
	}
	return null;
}

/**
 * How agents start `open-reel mcp` for this installation: this same program
 * (a compiled one by itself, Bun with this script otherwise), on the same
 * data and with the same resources, and where Claude Desktop keeps its
 * settings on this system.
 */
export async function agentsSetup(options: {
	/** Given when the server was told its data directory. */
	dataDir?: string;
	resources?: string;
	env?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	home?: string;
}): Promise<AgentsSetup> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? env.HOME ?? env.USERPROFILE ?? "";
	const compiled = /\$bunfs|~BUN/.test(Bun.main);
	// Agents start it from anywhere: every path is made whole.
	const code: Launch = {
		command: process.execPath,
		args: [
			...(compiled ? [] : [Bun.main]),
			"mcp",
			...(options.dataDir ? ["--data-dir", resolve(options.dataDir)] : []),
			...(options.resources ? ["--resources", resolve(options.resources)] : []),
		],
	};
	// The places it was told to keep things go with it.
	const kept = Object.fromEntries(
		["OPEN_REEL_DATA_DIR", "OPEN_REEL_MODELS_DIR"].flatMap((key) =>
			env[key] ? [[key, resolve(env[key] as string)]] : [],
		),
	);
	if (Object.keys(kept).length > 0) code.env = kept;

	if (platform === "win32") {
		const join = (...parts: string[]) =>
			parts.map((p) => p.replace(/\\+$/, "")).join("\\");
		const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
		const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
		const folder = (await storeFolder(local, join)) ?? join(appData, "Claude");
		return {
			code,
			desktop: code,
			shell: "powershell",
			claudeDesktopConfig: join(folder, CONFIG_FILE),
		};
	}
	if (platform === "darwin") {
		return {
			code,
			desktop: code,
			shell: "posix",
			claudeDesktopConfig: `${home}/Library/Application Support/Claude/${CONFIG_FILE}`,
		};
	}
	const distro = env.WSL_DISTRO_NAME;
	if (distro) {
		// Claude Desktop runs on the Windows side and reaches this one
		// through wsl.exe; -e runs the program itself, without a shell that
		// would split or expand its arguments. Windows' environment is not
		// passed along, so env sets what is kept.
		const unix = async (variable: string) => {
			const windows = await output(["cmd.exe", "/c", "echo", `%${variable}%`]);
			return windows && !windows.includes("%")
				? await output(["wslpath", "-u", windows])
				: null;
		};
		const [appData, local] = await Promise.all([
			unix("APPDATA"),
			unix("LOCALAPPDATA"),
		]);
		const join = (...parts: string[]) => parts.join("/");
		const folder =
			(local && (await storeFolder(local, join))) ??
			(appData ? join(appData, "Claude") : null);
		const pairs = Object.entries(kept).map(([key, value]) => `${key}=${value}`);
		return {
			code,
			desktop: {
				command: "wsl.exe",
				args: [
					"-d",
					distro,
					"-e",
					...(pairs.length > 0 ? ["env", ...pairs] : []),
					code.command,
					...code.args,
				],
			},
			shell: "posix",
			claudeDesktopConfig: folder ? join(folder, CONFIG_FILE) : null,
		};
	}
	const config = env.XDG_CONFIG_HOME ?? `${home}/.config`;
	return {
		code,
		desktop: code,
		shell: "posix",
		claudeDesktopConfig: `${config}/Claude/${CONFIG_FILE}`,
	};
}
