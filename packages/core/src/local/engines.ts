import type {
	Backend,
	EngineBuildSpec,
	Fit,
	Gpu,
	GpuVendor,
	Hardware,
	VariantSpec,
} from "../types";

export type { Backend, EngineBuildSpec, Fit, VariantSpec } from "../types";

/** Fastest first. */
const BACKEND_ORDER: Backend[] = ["cuda", "rocm", "metal", "vulkan", "cpu"];

/** The vendors whose GPUs each backend can drive. */
const BACKEND_VENDORS: Record<Backend, GpuVendor[]> = {
	cuda: ["nvidia"],
	rocm: ["amd"],
	metal: ["apple"],
	vulkan: ["nvidia", "amd", "intel"],
	cpu: [],
};

/** Why a build was picked, or why none could be. */
export interface BuildChoice<B extends EngineBuildSpec = EngineBuildSpec> {
	build: B;
	/** The GPU it will use; absent when it runs on the CPU. */
	gpu?: Gpu;
	/** Windows builds run from WSL, which reaches the GPU through Windows. */
	throughWindows: boolean;
}

function driverAtLeast(driver: string | undefined, minimum: string): boolean {
	if (!driver) return false;
	const [major = 0, minor = 0] = driver.split(".").map(Number);
	const [wantMajor = 0, wantMinor = 0] = minimum.split(".").map(Number);
	return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

/** The GPU with the most memory among those a backend can drive. */
function bestGpu(hardware: Hardware, backend: Backend): Gpu | undefined {
	return hardware.gpus
		.filter((gpu) => BACKEND_VENDORS[backend].includes(gpu.vendor))
		.sort((a, b) => b.memoryBytes - a.memoryBytes)[0];
}

/**
 * Picks the fastest build of `engine` this machine can run. Under WSL the
 * Windows builds are preferred for NVIDIA cards: WSL has no Vulkan driver for
 * them, and Windows runs CUDA natively.
 */
export function chooseBuild<B extends EngineBuildSpec>(
	engine: string,
	builds: B[],
	hardware: Hardware,
): BuildChoice<B> | null {
	const platforms: { os: string; throughWindows: boolean }[] = hardware.wsl
		? [
				{ os: "win32", throughWindows: true },
				{ os: "linux", throughWindows: false },
			]
		: [{ os: hardware.os, throughWindows: false }];

	for (const backend of BACKEND_ORDER) {
		const gpu = bestGpu(hardware, backend);
		if (backend !== "cpu" && !gpu) continue;
		for (const { os, throughWindows } of platforms) {
			const build = builds.find(
				(b) =>
					b.engine === engine &&
					b.backend === backend &&
					b.os === os &&
					b.arch === hardware.arch &&
					(!b.minNvidiaDriver || driverAtLeast(gpu?.driver, b.minNvidiaDriver)),
			);
			if (!build) continue;
			// Under WSL a Linux GPU build cannot see the card; only the CPU one helps.
			if (hardware.wsl && !throughWindows && backend !== "cpu") continue;
			return { build, ...(gpu && { gpu }), throughWindows };
		}
	}
	return null;
}

/** Leaves room for the system and the rest of the job in RAM. */
const RAM_HEADROOM = 0.8;

/** How well a variant runs with a build on this machine. */
export function fitOf(
	variant: VariantSpec,
	hardware: Hardware,
	choice: BuildChoice | null,
): Fit {
	if (!choice) return "none";
	const ram = hardware.memoryBytes * RAM_HEADROOM;
	if (!choice.gpu) return variant.memoryBytes <= ram ? "cpu" : "none";
	if (variant.memoryBytes <= choice.gpu.memoryBytes) return "gpu";
	// Apple GPUs already share system memory: there is nowhere to offload to.
	if (choice.gpu.vendor === "apple") return "none";
	return variant.memoryBytes <= choice.gpu.memoryBytes + ram
		? "offload"
		: "none";
}

/**
 * Picks the variant to install. Variants are listed best quality first; the
 * best one that fits the GPU wins, then the one that needs the least
 * offloading. Null when no variant runs on this machine at all.
 */
export function chooseVariant<V extends VariantSpec, B extends EngineBuildSpec>(
	variants: V[],
	hardware: Hardware,
	builds: (engine: string) => BuildChoice<B> | null,
): { variant: V; fit: Fit; build: BuildChoice<B> } | null {
	const runnable = variants.flatMap((variant) => {
		const build = builds(variant.engine);
		if (!build) return [];
		const fit = fitOf(variant, hardware, build);
		return fit === "none" ? [] : [{ variant, fit, build }];
	});
	return (
		runnable.find((choice) => choice.fit === "gpu") ??
		runnable.sort((a, b) => a.variant.memoryBytes - b.variant.memoryBytes)[0] ??
		null
	);
}
