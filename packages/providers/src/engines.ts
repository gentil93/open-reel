import type { EngineBuild, LocalEngineSpec } from "@open-reel/core";

const SD_CPP_VERSION = "master-1106-532d2c1";

const release = (name: string) =>
	`https://github.com/leejet/stable-diffusion.cpp/releases/download/${SD_CPP_VERSION}/${name}`;

const archive = (name: string, size: number, sha256: string) => ({
	name,
	url: release(name),
	size,
	sha256,
});

const build = (
	backend: EngineBuild["backend"],
	os: EngineBuild["os"],
	arch: EngineBuild["arch"],
	files: EngineBuild["files"],
	extra: Partial<EngineBuild> = {},
): EngineBuild => ({
	id: `sd-cpp-${os}-${arch}-${backend}`,
	engine: "sd-cpp",
	version: SD_CPP_VERSION,
	backend,
	os,
	arch,
	files,
	executable: os === "win32" ? "sd-cli.exe" : "sd-cli",
	...extra,
});

/**
 * The engines that run local models, as official release builds. Sizes and
 * hashes are the ones GitHub reports for the release.
 *
 * stable-diffusion.cpp publishes no Linux build that runs on current LTS
 * distributions (they need glibc 2.43), nor a Linux CUDA build, so Linux is
 * served only under WSL, through the Windows builds, until open-reel ships
 * builds of its own.
 */
export function builtinEngines(): LocalEngineSpec[] {
	return [
		{
			id: "sd-cpp",
			name: "stable-diffusion.cpp",
			homepage: "https://github.com/leejet/stable-diffusion.cpp",
			license: "MIT",
			builds: [
				build(
					"cuda",
					"win32",
					"x64",
					[
						archive(
							"sd-master-532d2c1-bin-win-cuda12-x64.zip",
							412_365_497,
							"b087219145a382cc1b1e826318289e1f672b9bb6965977734ef0deb85fe2d03a",
						),
						archive(
							"cudart-sd-bin-win-cu12-x64.zip",
							563_452_046,
							"fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d",
						),
					],
					// CUDA 12 programs run on drivers from this release on.
					{ minNvidiaDriver: "527.41" },
				),
				build("rocm", "win32", "x64", [
					archive(
						"sd-master-532d2c1-bin-win-rocm-10.1.0-x64.zip",
						283_581_117,
						"b10fcc88f5a37adc1b63e0c1bd06fcbc8212340a68b96022b45d72e64c9e45a1",
					),
				]),
				build("vulkan", "win32", "x64", [
					archive(
						"sd-master-532d2c1-bin-win-vulkan-x64.zip",
						30_312_081,
						"3e66222c87ca27074e1fd8ce79706eef17a8aaf39949906aa1bee7e060f22ecc",
					),
				]),
				build("cpu", "win32", "x64", [
					archive(
						"sd-master-532d2c1-bin-win-cpu-x64.zip",
						18_358_541,
						"abef332cfca7861cc567910e79bedb70bfb2920bb4eedac97fcbb6db477f1596",
					),
				]),
				build("metal", "darwin", "arm64", [
					archive(
						"sd-master-532d2c1-bin-Darwin-macOS-26.7.2-arm64.zip",
						38_331_254,
						"8146d6ffc75f8ff8f64b62a80fffee8fb714ab65e368e202084135fa07cc6f36",
					),
				]),
			],
		},
	];
}
