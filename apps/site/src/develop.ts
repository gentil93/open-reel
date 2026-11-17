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
	const p = Math.min(1, Math.max(0, progress));
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
	if (p >= 1) return;
	ctx.globalAlpha = (1 - p) ** 1.4;
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

export function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`Could not load ${src}`));
		image.src = src;
	});
}
