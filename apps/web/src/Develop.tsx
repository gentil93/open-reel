import { develop, latent, loadImage } from "@open-reel/darkroom";
import { type ReactNode, useEffect, useRef, useState } from "react";

/** Develop and latent frames redraw at film speed: lively, and cheap. */
const FRAME_MS = 1000 / 24;
const DEVELOP_MS = 1600;
/** Canvases stay small; they are covered by the real picture once done. */
const CANVAS_MAX = 480;

export const reduceMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function canvasSize(ratio: number): [number, number] {
	return ratio >= 1
		? [CANVAS_MAX, Math.round(CANVAS_MAX / ratio)]
		: [Math.round(CANVAS_MAX * ratio), CANVAS_MAX];
}

/**
 * A picture still being made: static under a safelight that warms as
 * `fraction` grows. `children` sit on top, such as a status line and a button.
 */
export function LatentFrame(props: {
	ratio: number;
	fraction: number | undefined;
	children?: ReactNode;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	// Read by the animation loop without restarting it on every progress event.
	const fraction = useRef(props.fraction);
	fraction.current = props.fraction;
	const [width, height] = canvasSize(props.ratio);

	// biome-ignore lint/correctness/useExhaustiveDependencies: resizing the canvas clears it, so a new size starts the drawing again
	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		if (reduceMotion()) {
			latent(element, 0.3, 0);
			return;
		}
		// Drawn at once, so the frame is never blank while animation frames wait.
		latent(element, fraction.current, performance.now());
		let frame = 0;
		let last = 0;
		const draw = (time: number) => {
			frame = requestAnimationFrame(draw);
			if (time - last < FRAME_MS) return;
			last = time;
			latent(element, fraction.current, time);
		};
		frame = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(frame);
	}, [width, height]);

	return (
		<div
			className="relative overflow-hidden rounded-md bg-bg"
			style={{ aspectRatio: String(props.ratio) }}
		>
			<canvas
				ref={canvas}
				width={width}
				height={height}
				className="absolute inset-0 h-full w-full"
			/>
			<div className="relative flex h-full flex-col items-center justify-center gap-3 p-4">
				{props.children}
			</div>
			<div
				aria-hidden="true"
				className="absolute inset-x-0 bottom-0 h-0.5 bg-line"
			>
				<div
					className={`h-full ${props.fraction == null ? "film-edge w-full opacity-60" : "bg-accent"} transition-[width] duration-500`}
					style={
						props.fraction == null
							? undefined
							: { width: `${Math.round(props.fraction * 100)}%` }
					}
				/>
			</div>
		</div>
	);
}

/**
 * A finished picture. With `fresh`, it develops out of grain once, as a
 * print does in the tray; otherwise it simply fades in.
 */
export function DevelopedImage(props: {
	src: string;
	alt: string;
	fresh: boolean;
	/** Width over height, to hold the frame's shape before the image loads. */
	ratio: number;
	className?: string;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [developing, setDeveloping] = useState(
		() => props.fresh && !reduceMotion(),
	);

	useEffect(() => {
		if (!developing) return;
		let frame = 0;
		let stopped = false;
		loadImage(props.src)
			.then((image) => {
				const element = canvas.current;
				if (stopped || !element) return;
				[element.width, element.height] = canvasSize(
					image.width / image.height,
				);
				const start = performance.now();
				let last = 0;
				const draw = (time: number) => {
					const t = Math.min(1, (time - start) / DEVELOP_MS);
					if (t < 1) frame = requestAnimationFrame(draw);
					else setDeveloping(false);
					if (t < 1 && time - last < FRAME_MS) return;
					last = time;
					// Fast at first, lingering as the last details come in.
					develop(element, image, 1 - (1 - t) ** 3);
				};
				frame = requestAnimationFrame(draw);
			})
			.catch(() => setDeveloping(false));
		return () => {
			stopped = true;
			cancelAnimationFrame(frame);
		};
	}, [developing, props.src]);

	return (
		<span
			className="relative block"
			style={developing ? { aspectRatio: String(props.ratio) } : undefined}
		>
			<img
				src={props.src}
				alt={props.alt}
				loading="lazy"
				className={`${props.className ?? ""} ${
					developing
						? "opacity-0"
						: // A developed print is already on screen; only the others fade in.
							props.fresh
							? ""
							: "print-in"
				}`}
			/>
			{developing && (
				<canvas
					ref={canvas}
					className={`absolute inset-0 h-full w-full ${props.className ?? ""}`}
				/>
			)}
		</span>
	);
}
