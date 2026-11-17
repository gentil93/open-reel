/**
 * The effects the site and the app share: pictures that come out of noise the
 * way a diffusion model shows them partway through, under the Aurora light.
 */

const NOISE_SIZE = 256;
let noise: HTMLCanvasElement | null = null;

/** Grain shared by every developing picture, made once. */
function noiseTexture(): HTMLCanvasElement {
	if (noise) return noise;
	noise = document.createElement("canvas");
	noise.width = noise.height = NOISE_SIZE;
	const ctx = noise.getContext("2d") as CanvasRenderingContext2D;
	const data = ctx.createImageData(NOISE_SIZE, NOISE_SIZE);
	for (let i = 0; i < data.data.length; i += 4) {
		const value = Math.random() * 255;
		data.data[i] = value;
		data.data[i + 1] = value * 0.92;
		data.data[i + 2] = value * 0.96;
		data.data[i + 3] = 255;
	}
	ctx.putImageData(data, 0, 0);
	return noise;
}

/** Covers the canvas with grain at `alpha`, shifted at random so it flickers. */
function grain(ctx: CanvasRenderingContext2D, alpha: number): void {
	const { width, height } = ctx.canvas;
	ctx.globalAlpha = alpha;
	ctx.fillStyle = ctx.createPattern(noiseTexture(), "repeat") as CanvasPattern;
	ctx.save();
	ctx.translate(Math.random() * NOISE_SIZE, Math.random() * NOISE_SIZE);
	ctx.fillRect(
		-NOISE_SIZE,
		-NOISE_SIZE,
		width + NOISE_SIZE * 2,
		height + NOISE_SIZE * 2,
	);
	ctx.restore();
	ctx.globalAlpha = 1;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Draws `image` the way a diffusion model shows it partway through:
 * `progress` 0 is pure static, 1 is the finished picture.
 */
export function develop(
	canvas: HTMLCanvasElement,
	image: HTMLImageElement,
	progress: number,
): void {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const p = clamp(progress);
	const { width, height } = canvas;
	const scale = Math.max(width / image.width, height / image.height);
	ctx.filter = `blur(${(1 - p) * 26}px) saturate(${0.4 + p * 0.6})`;
	ctx.drawImage(
		image,
		(width - image.width * scale) / 2,
		(height - image.height * scale) / 2,
		image.width * scale,
		image.height * scale,
	);
	ctx.filter = "none";
	if (p < 1) grain(ctx, (1 - p) ** 1.4);
}

/**
 * Draws a picture that does not exist yet: noise under Aurora light that
 * drifts with `time` (in milliseconds) and grows brighter and calmer as
 * `progress` goes from 0 to 1. Without a progress, the light breathes so the
 * frame still looks alive.
 */
export function latent(
	canvas: HTMLCanvasElement,
	progress: number | undefined,
	time: number,
): void {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const { width, height } = canvas;
	const p =
		progress == null ? 0.25 + Math.sin(time / 900) * 0.12 : clamp(progress);
	ctx.fillStyle = "#0d0d10";
	ctx.fillRect(0, 0, width, height);
	// Two lights, pink and gold, drifting around each other.
	const lights: [number, number, string][] = [
		[Math.sin(time / 1300), Math.cos(time / 1700), "255, 61, 139"],
		[Math.cos(time / 1500), Math.sin(time / 1100), "255, 200, 97"],
	];
	for (const [dx, dy, rgb] of lights) {
		const x = width * (0.5 + dx * 0.28);
		const y = height * (0.5 + dy * 0.22);
		const glow = ctx.createRadialGradient(
			x,
			y,
			0,
			x,
			y,
			Math.max(width, height) * (0.35 + p * 0.5),
		);
		glow.addColorStop(0, `rgba(${rgb}, ${0.22 + p * 0.3})`);
		glow.addColorStop(0.55, `rgba(255, 138, 61, ${0.08 + p * 0.12})`);
		glow.addColorStop(1, "rgba(255, 138, 61, 0)");
		ctx.fillStyle = glow;
		ctx.fillRect(0, 0, width, height);
	}
	grain(ctx, 0.3 - p * 0.14);
}

export function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`Could not load ${src}`));
		image.src = src;
	});
}
