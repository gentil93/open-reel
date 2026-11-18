import type {
	Fit,
	Hardware,
	LocalModelStatus,
	Media,
	ModelProfile,
	ModelSpec,
	ProviderStatus,
} from "@open-reel/core/types";

/** How a local model runs here, in the words people see. */
export type FitLevel = "great" | "slow" | "none";

export function fitLevel(fit: Fit): FitLevel {
	if (fit === "gpu") return "great";
	if (fit === "none") return "none";
	return "slow";
}

/** How the version of `model` that would be installed runs on this computer. */
export function localFit(model: LocalModelStatus): Fit {
	return model.variants.find((v) => v.id === model.variant)?.fit ?? "none";
}

/** Graphics memory the chosen version needs, for the memory meter. */
export function neededMemory(model: LocalModelStatus): number | null {
	return (
		model.variants.find((v) => v.id === model.variant)?.memoryBytes ?? null
	);
}

/** The largest graphics memory on this computer, or null without a GPU. */
export function gpuMemory(hardware: Hardware): number | null {
	const sizes = hardware.gpus.map((gpu) => gpu.memoryBytes);
	return sizes.length > 0 ? Math.max(...sizes) : null;
}

const FIT_ORDER: Fit[] = ["gpu", "offload", "cpu", "none"];
/** Few-step models, which make a first picture in seconds, fastest first. */
const QUICK_MODELS = ["sdxl-turbo", "z-image-turbo", "flux-schnell"];

/**
 * The local model to recommend on this computer for `media`: ready ones
 * first, then ones installing, then the best fit, the quickest and the
 * smallest. None when nothing would run on the graphics card, since a model
 * that takes minutes per picture is a poor first impression.
 */
export function bestLocal(
	models: LocalModelStatus[],
	media: Media = "image",
): LocalModelStatus | undefined {
	const fit = (model: LocalModelStatus) => FIT_ORDER.indexOf(localFit(model));
	const quick = (model: LocalModelStatus) => {
		const index = QUICK_MODELS.indexOf(model.id);
		return index === -1 ? QUICK_MODELS.length : index;
	};
	return models
		.filter(
			(m) =>
				m.media === media &&
				// An upscaler only enlarges pictures it is given.
				!m.tasks.includes("upscale") &&
				m.variant != null &&
				(localFit(m) === "gpu" || localFit(m) === "offload"),
		)
		.sort(
			(a, b) =>
				Number(b.ready) - Number(a.ready) ||
				Number(b.state !== "available") - Number(a.state !== "available") ||
				fit(a) - fit(b) ||
				quick(a) - quick(b) ||
				a.size - b.size,
		)[0];
}

/** The shelves the local models are sorted on, by what each is mainly for. */
export type LocalCategory = "image" | "edit" | "video";

export function categoryOf(
	model: Pick<LocalModelStatus, "tasks">,
): LocalCategory {
	const main = model.tasks[0];
	if (main === "image-edit" || main === "upscale") return "edit";
	if (main === "text-to-video" || main === "image-to-video") return "video";
	return "image";
}

/** Whether a model belongs on a shelf: its main use, or one it also has. */
export function inCategory(
	model: Pick<LocalModelStatus, "tasks">,
	category: LocalCategory,
): boolean {
	return model.tasks.some((task) =>
		category === "edit"
			? task === "image-edit" || task === "image-to-image" || task === "upscale"
			: category === "video"
				? task === "text-to-video" || task === "image-to-video"
				: task === "text-to-image",
	);
}

/** What the local models list can be narrowed to. */
export interface LocalFilter {
	category: LocalCategory | "all";
	/** Only those that run on the graphics card at full speed. */
	runsWell: boolean;
	/** Only those whose license allows paid work without limits. */
	commercial: boolean;
	installed: boolean;
}

export function filterLocal(
	models: LocalModelStatus[],
	filter: LocalFilter,
): LocalModelStatus[] {
	return models.filter(
		(model) =>
			(filter.category === "all" || inCategory(model, filter.category)) &&
			(!filter.runsWell || localFit(model) === "gpu") &&
			(!filter.commercial || model.commercial.kind === "allowed") &&
			(!filter.installed || model.state !== "available"),
	);
}

/**
 * Best for this computer first: installed, then how well it runs here, then
 * quality and speed, then the smaller download.
 */
export function sortLocal(models: LocalModelStatus[]): LocalModelStatus[] {
	const fit = (model: LocalModelStatus) => FIT_ORDER.indexOf(localFit(model));
	return models.toSorted(
		(a, b) =>
			Number(b.state !== "available") - Number(a.state !== "available") ||
			fit(a) - fit(b) ||
			(b.profile?.quality ?? 0) - (a.profile?.quality ?? 0) ||
			(b.profile?.speed ?? 0) - (a.profile?.speed ?? 0) ||
			a.size - b.size,
	);
}

/**
 * The model to recommend on each shelf for this computer: of those that run
 * on its graphics card at full speed, the best, then the quickest, then the
 * smallest. A shelf where nothing runs that well has none.
 */
export function recommendedLocal(models: LocalModelStatus[]): Set<string> {
	const picks = new Set<string>();
	for (const category of ["image", "edit", "video"] as const) {
		const best = models
			.filter((m) => categoryOf(m) === category && localFit(m) === "gpu")
			.toSorted(
				(a, b) =>
					(b.profile?.quality ?? 0) - (a.profile?.quality ?? 0) ||
					(b.profile?.speed ?? 0) - (a.profile?.speed ?? 0) ||
					a.size - b.size,
			)[0];
		if (best) picks.add(best.id);
	}
	return picks;
}

const price = (model: ModelSpec) =>
	model.pricing?.usdPerOutput ?? Number.POSITIVE_INFINITY;

const readyProviders = (providers: ProviderStatus[]) =>
	new Set(providers.filter((p) => p.hasKey || !p.requiresKey).map((p) => p.id));

/** The model a first picture should use: free first, then the cheapest. */
export function firstModel(
	models: ModelSpec[],
	providers: ProviderStatus[],
): ModelSpec | undefined {
	const ready = readyProviders(providers);
	return models
		.filter(
			(m) =>
				m.media === "image" &&
				m.capabilities.upscale == null &&
				ready.has(m.providerId),
		)
		.sort((a, b) => price(a) - price(b))[0];
}

/** One cloud model, reached through one or more services. */
export interface Family {
	profile: ModelProfile;
	media: Media;
	/** Every way to reach it, one per service and version. */
	routes: ModelSpec[];
	/** The route to use now: one whose service has a key. */
	ready?: ModelSpec;
}

/**
 * Cloud models of `media` grouped by family, best first. Local models are
 * left out: they are chosen from the local catalog, installed or not.
 */
export function cloudFamilies(
	models: ModelSpec[],
	providers: ProviderStatus[],
	media: Media,
): Family[] {
	const ready = readyProviders(providers);
	const families = new Map<string, Family>();
	for (const model of models) {
		const profile = model.profile;
		if (!profile || model.providerId === "local" || model.media !== media) {
			continue;
		}
		const family = families.get(profile.family) ?? {
			profile,
			media: model.media,
			routes: [],
		};
		family.routes.push(model);
		if (!family.ready && ready.has(model.providerId)) family.ready = model;
		families.set(profile.family, family);
	}
	return [...families.values()].sort(
		(a, b) =>
			b.profile.quality - a.profile.quality ||
			b.profile.speed - a.profile.speed ||
			a.profile.name.localeCompare(b.profile.name),
	);
}

/** The cloud family to recommend when nothing runs well on this computer. */
export function bestCloud(families: Family[]): Family | undefined {
	return families.toSorted(
		(a, b) =>
			Number(Boolean(b.ready)) - Number(Boolean(a.ready)) ||
			b.profile.speed - a.profile.speed ||
			b.profile.quality - a.profile.quality,
	)[0];
}
