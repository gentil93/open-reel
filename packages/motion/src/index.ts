/**
 * The effects the site and the app share: a picture coming into focus as a
 * model makes it, under the Aurora light. No grain: the picture is blurred
 * and dim at first, and sharpens as it forms.
 */

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Draws `image` as it looks partway through: `progress` 0 is a soft blur of
 * its colors, 1 is the finished picture.
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
	// Eased, so the last details settle slowly rather than snapping in.
	const rest = (1 - p) ** 1.6;
	const blur = rest * Math.max(width, height) * 0.06;
	// A slight zoom hides the soft edges a blur leaves at the borders.
	const zoom = 1 + rest * 0.08;
	const scale = Math.max(width / image.width, height / image.height) * zoom;
	ctx.fillStyle = "#0d0d10";
	ctx.fillRect(0, 0, width, height);
	ctx.filter = `blur(${blur}px) saturate(${0.55 + p * 0.45}) brightness(${0.75 + p * 0.25})`;
	ctx.drawImage(
		image,
		(width - image.width * scale) / 2,
		(height - image.height * scale) / 2,
		image.width * scale,
		image.height * scale,
	);
	ctx.filter = "none";
}

/**
 * Draws a picture that does not exist yet: soft Aurora light that drifts with
 * `time` (in milliseconds) and grows brighter as `progress` goes from 0 to 1.
 * Without a progress, the light breathes so the frame still looks alive.
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
}

export function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`Could not load ${src}`));
		image.src = src;
	});
}
