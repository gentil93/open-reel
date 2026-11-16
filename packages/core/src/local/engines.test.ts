import { describe, expect, test } from "bun:test";
import {
	type BuildChoice,
	chooseBuild,
	chooseVariant,
	type EngineBuildSpec,
	type Hardware,
	type VariantSpec,
} from "../index";

const GB = 1024 ** 3;

const build = (
	backend: EngineBuildSpec["backend"],
	os: EngineBuildSpec["os"],
	arch: EngineBuildSpec["arch"] = "x64",
	extra: Partial<EngineBuildSpec> = {},
): EngineBuildSpec => ({
	id: `sd-${os}-${arch}-${backend}`,
	engine: "sd",
	backend,
	os,
	arch,
	...extra,
});
const BUILDS = [
	build("cuda", "win32", "x64", { minNvidiaDriver: "527.41" }),
	build("vulkan", "win32"),
	build("cpu", "win32"),
	build("rocm", "linux"),
	build("vulkan", "linux"),
	build("cpu", "linux"),
	build("metal", "darwin", "arm64"),
];

const machine = (over: Partial<Hardware>): Hardware => ({
	os: "linux",
	arch: "x64",
	wsl: false,
	memoryBytes: 32 * GB,
	gpus: [],
	...over,
});
const nvidia = (memory: number, driver = "616.56") => ({
	vendor: "nvidia" as const,
	name: "NVIDIA card",
	memoryBytes: memory * GB,
	driver,
});

describe("choosing a build", () => {
	const pick = (hardware: Hardware) =>
		chooseBuild("sd", BUILDS, hardware)?.build.id;

	test("CUDA on Windows with an NVIDIA card", () => {
		expect(pick(machine({ os: "win32", gpus: [nvidia(12)] }))).toBe(
			"sd-win32-x64-cuda",
		);
	});

	test("an NVIDIA driver too old for CUDA falls back to Vulkan", () => {
		expect(pick(machine({ os: "win32", gpus: [nvidia(12, "472.12")] }))).toBe(
			"sd-win32-x64-vulkan",
		);
	});

	test("WSL with an NVIDIA card runs the Windows CUDA build", () => {
		const choice = chooseBuild(
			"sd",
			BUILDS,
			machine({ wsl: true, gpus: [nvidia(12)] }),
		);
		expect(choice?.build.id).toBe("sd-win32-x64-cuda");
		expect(choice?.throughWindows).toBe(true);
		expect(choice?.gpu?.memoryBytes).toBe(12 * GB);
	});

	test("WSL without a usable Windows build runs on the CPU, not Linux Vulkan", () => {
		const linuxOnly = BUILDS.filter((b) => b.os === "linux");
		const choice = chooseBuild(
			"sd",
			linuxOnly,
			machine({ wsl: true, gpus: [nvidia(12)] }),
		);
		expect(choice?.build.id).toBe("sd-linux-x64-cpu");
		expect(choice?.gpu).toBeUndefined();
	});

	test("AMD on Linux uses ROCm, Apple silicon uses Metal", () => {
		expect(
			pick(
				machine({
					gpus: [{ vendor: "amd", name: "RX 7900", memoryBytes: 24 * GB }],
				}),
			),
		).toBe("sd-linux-x64-rocm");
		expect(
			pick(
				machine({
					os: "darwin",
					arch: "arm64",
					gpus: [{ vendor: "apple", name: "M3", memoryBytes: 27 * GB }],
				}),
			),
		).toBe("sd-darwin-arm64-metal");
	});

	test("no GPU means the CPU build, and no build means null", () => {
		expect(pick(machine({}))).toBe("sd-linux-x64-cpu");
		expect(pick(machine({ os: "darwin", arch: "x64" }))).toBeUndefined();
		expect(chooseBuild("other", BUILDS, machine({}))).toBeNull();
	});

	test("the GPU with the most memory is the one used", () => {
		const choice = chooseBuild(
			"sd",
			BUILDS,
			machine({ os: "win32", gpus: [nvidia(8), nvidia(24)] }),
		);
		expect(choice?.gpu?.memoryBytes).toBe(24 * GB);
	});
});

describe("choosing a variant", () => {
	const variant = (id: string, memory: number, engine = "sd"): VariantSpec => ({
		id,
		label: id,
		engine,
		memoryBytes: memory * GB,
	});
	const FLUX = [variant("q8", 14), variant("q4", 8), variant("q2", 5)];
	const pick = (hardware: Hardware, variants = FLUX) => {
		const choice = chooseVariant(variants, hardware, (engine) =>
			chooseBuild(engine, BUILDS, hardware),
		);
		return choice && [choice.variant.id, choice.fit];
	};
	const win = (gpus: Hardware["gpus"], memory = 32) =>
		machine({ os: "win32", gpus, memoryBytes: memory * GB });

	test("the best quality that fits the GPU", () => {
		expect(pick(win([nvidia(24)]))).toEqual(["q8", "gpu"]);
		expect(pick(win([nvidia(12)]))).toEqual(["q4", "gpu"]);
		expect(pick(win([nvidia(6)]))).toEqual(["q2", "gpu"]);
	});

	test("when nothing fits the GPU, the least offloading", () => {
		expect(pick(win([nvidia(4)]))).toEqual(["q2", "offload"]);
		expect(pick(win([nvidia(4)], 4))).toEqual(["q2", "offload"]);
		expect(pick(win([nvidia(2)], 2))).toBeNull();
	});

	test("without a GPU, the smallest that fits in RAM", () => {
		expect(pick(machine({ memoryBytes: 16 * GB }))).toEqual(["q2", "cpu"]);
		expect(pick(machine({ memoryBytes: 4 * GB }))).toBeNull();
	});

	test("Apple silicon cannot offload past its shared memory", () => {
		const mac = (memory: number) =>
			machine({
				os: "darwin",
				arch: "arm64",
				memoryBytes: memory * GB,
				gpus: [
					{ vendor: "apple", name: "M2", memoryBytes: memory * 0.75 * GB },
				],
			});
		expect(pick(mac(16))).toEqual(["q4", "gpu"]);
		expect(pick(mac(4))).toBeNull();
	});

	test("a variant whose engine cannot run here is skipped", () => {
		const choice = chooseVariant(
			[variant("comfy", 8, "comfy"), variant("q4", 8)],
			win([nvidia(12)]),
			(engine): BuildChoice | null =>
				engine === "sd" ? chooseBuild("sd", BUILDS, win([nvidia(12)])) : null,
		);
		expect(choice?.variant.id).toBe("q4");
	});
});
