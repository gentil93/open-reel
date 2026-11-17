/**
 * The Darkroom effects the site and the app share: pictures that come out of
 * grain the way a diffusion model shows them partway through.
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
		data.data[i + 1] = value * 0.96;
		data.data[i + 2] = value * 0.9;
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
 * Draws a picture that does not exist yet: static under a safelight that
 * warms as `progress` goes from 0 to 1. Without a progress, the light breathes
 * with `time` (in milliseconds) so the frame still looks alive.
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
	ctx.fillStyle = "#0d0b09";
	ctx.fillRect(0, 0, width, height);
	// The safelight: an amber glow that grows as the picture forms.
	const radius = Math.max(width, height) * (0.35 + p * 0.55);
	const glow = ctx.createRadialGradient(
		width / 2,
		height * 0.55,
		0,
		width / 2,
		height * 0.55,
		radius,
	);
	glow.addColorStop(0, `rgba(240, 166, 58, ${0.1 + p * 0.28})`);
	glow.addColorStop(1, "rgba(240, 166, 58, 0)");
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, width, height);
	grain(ctx, 0.32 - p * 0.14);
}

export function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`Could not load ${src}`));
		image.src = src;
	});
}
