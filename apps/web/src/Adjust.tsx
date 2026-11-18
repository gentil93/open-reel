import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "./i18n";

interface Props {
	/** The picture to adjust. */
	src: string;
	/** Gets the adjusted picture. */
	onDone(picture: Blob): Promise<void>;
	onClose(): void;
}

/** A part of the picture, as fractions of its turned width and height. */
interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

type Shape = "free" | "original" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";

const SHAPES: Shape[] = [
	"free",
	"original",
	"1:1",
	"4:3",
	"3:4",
	"16:9",
	"9:16",
];
/** Longest side of the result; 0 keeps the cropped size. */
const SIDES = [0, 2048, 1536, 1024, 768, 512];
/** Pictures larger than this are worked on smaller: browsers run out of memory. */
const MAX_WORK_SIDE = 4096;
/** The smallest crop, as a fraction of the picture. */
const MIN_FRACTION = 0.05;

const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };

/** The largest box of `ratio` (width / height, in pixels) centred in the picture. */
function centred(ratio: number, width: number, height: number): Box {
	const w = Math.min(width, height * ratio);
	const h = w / ratio;
	return {
		x: (width - w) / 2 / width,
		y: (height - h) / 2 / height,
		w: w / width,
		h: h / height,
	};
}

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

/** Turns, flips and crops pictures before they are used, in the browser. */
export function Adjust({ src, onDone, onClose }: Props) {
	const { t, explain, number } = useI18n();
	const dialog = useRef<HTMLDialogElement>(null);
	const frame = useRef<HTMLDivElement>(null);
	const [image, setImage] = useState<HTMLImageElement | null>(null);
	const [turns, setTurns] = useState(0);
	const [flipped, setFlipped] = useState(false);
	const [shape, setShape] = useState<Shape>("free");
	const [box, setBox] = useState<Box>(FULL);
	const [side, setSide] = useState(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const drag = useRef<{
		mode: "move" | "nw" | "ne" | "sw" | "se";
		start: { x: number; y: number };
		box: Box;
	} | null>(null);

	useEffect(() => {
		dialog.current?.showModal();
		const loaded = new Image();
		loaded.onload = () => setImage(loaded);
		loaded.src = src;
	}, [src]);

	/** The picture as turned and flipped, at most MAX_WORK_SIDE long. */
	const turned = useMemo(() => {
		if (!image) return null;
		const scale = Math.min(
			1,
			MAX_WORK_SIDE / Math.max(image.naturalWidth, image.naturalHeight),
		);
		const w = Math.round(image.naturalWidth * scale);
		const h = Math.round(image.naturalHeight * scale);
		const sideways = turns % 2 === 1;
		const canvas = document.createElement("canvas");
		canvas.width = sideways ? h : w;
		canvas.height = sideways ? w : h;
		const context = canvas.getContext("2d");
		if (!context) return null;
		context.translate(canvas.width / 2, canvas.height / 2);
		// Mirrored as seen, left to right, however it is turned.
		if (flipped) context.scale(-1, 1);
		context.rotate((turns * Math.PI) / 2);
		context.drawImage(image, -w / 2, -h / 2, w, h);
		return canvas;
	}, [image, turns, flipped]);

	const preview = useRef<HTMLCanvasElement>(null);
	// Before painting, so the crop never shows over the previous size.
	useLayoutEffect(() => {
		const canvas = preview.current;
		if (!canvas || !turned) return;
		// Shown at most 1600 long: enough for the screen.
		const scale = Math.min(1, 1600 / Math.max(turned.width, turned.height));
		canvas.width = Math.round(turned.width * scale);
		canvas.height = Math.round(turned.height * scale);
		canvas
			.getContext("2d")
			?.drawImage(turned, 0, 0, canvas.width, canvas.height);
	}, [turned]);

	/** Width / height of the crop's shape, in pixels, or null when free. */
	const ratioOf = (which: Shape): number | null => {
		if (which === "free" || !image) return null;
		if (which === "original") {
			const sideways = turns % 2 === 1;
			return sideways
				? image.naturalHeight / image.naturalWidth
				: image.naturalWidth / image.naturalHeight;
		}
		const [w = 1, h = 1] = which.split(":").map(Number);
		return w / h;
	};

	const reshape = (which: Shape, width?: number, height?: number) => {
		setShape(which);
		const ratio = ratioOf(which);
		const w = width ?? turned?.width ?? 1;
		const h = height ?? turned?.height ?? 1;
		setBox(ratio == null ? FULL : centred(ratio, w, h));
	};

	const turn = (by: number) => {
		const next = (turns + by + 4) % 4;
		setTurns(next);
		// The crop starts over on the turned picture, keeping its shape.
		if (!turned) return;
		const sideways = (next - turns) % 2 !== 0;
		const w = sideways ? turned.height : turned.width;
		const h = sideways ? turned.width : turned.height;
		const ratio =
			shape === "original" ? w / h : shape === "free" ? null : ratioOf(shape);
		setBox(ratio == null ? FULL : centred(ratio, w, h));
	};

	const reset = () => {
		setTurns(0);
		setFlipped(false);
		setShape("free");
		setBox(FULL);
		setSide(0);
	};

	const onPointerDown = (
		event: React.PointerEvent,
		mode: "move" | "nw" | "ne" | "sw" | "se",
	) => {
		event.stopPropagation();
		(event.target as Element).setPointerCapture(event.pointerId);
		drag.current = {
			mode,
			start: { x: event.clientX, y: event.clientY },
			box,
		};
	};

	const onPointerMove = (event: React.PointerEvent) => {
		const held = drag.current;
		const area = frame.current?.getBoundingClientRect();
		if (!held || !area || !turned) return;
		const dx = (event.clientX - held.start.x) / area.width;
		const dy = (event.clientY - held.start.y) / area.height;
		const from = held.box;
		if (held.mode === "move") {
			setBox({
				...from,
				x: clamp(from.x + dx, 0, 1 - from.w),
				y: clamp(from.y + dy, 0, 1 - from.h),
			});
			return;
		}
		// The corner held moves; the opposite one stays.
		const west = held.mode === "nw" || held.mode === "sw";
		const north = held.mode === "nw" || held.mode === "ne";
		const fixedX = west ? from.x + from.w : from.x;
		const fixedY = north ? from.y + from.h : from.y;
		let w = clamp(
			west ? from.w - dx : from.w + dx,
			MIN_FRACTION,
			west ? fixedX : 1 - fixedX,
		);
		let h = clamp(
			north ? from.h - dy : from.h + dy,
			MIN_FRACTION,
			north ? fixedY : 1 - fixedY,
		);
		const ratio = ratioOf(shape);
		if (ratio != null) {
			// In fractions, a shape's height follows from its width.
			const perWidth = turned.width / turned.height / ratio;
			if (h > w * perWidth) h = w * perWidth;
			else w = h / perWidth;
		}
		setBox({
			x: west ? fixedX - w : fixedX,
			y: north ? fixedY - h : fixedY,
			w,
			h,
		});
	};

	/** Arrows move the crop; with Shift they make it larger or smaller. */
	const onKey = (event: React.KeyboardEvent) => {
		const step = 0.02;
		const moves: Record<string, [number, number]> = {
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, -step],
			ArrowDown: [0, step],
		};
		const move = moves[event.key];
		if (!move || !turned) return;
		event.preventDefault();
		const [dx, dy] = move;
		const ratio = ratioOf(shape);
		const perWidth =
			ratio == null ? null : turned.width / turned.height / ratio;
		// From the latest box: keys can repeat faster than it is drawn.
		setBox((box) => {
			if (!event.shiftKey) {
				return {
					...box,
					x: clamp(box.x + dx, 0, 1 - box.w),
					y: clamp(box.y + dy, 0, 1 - box.h),
				};
			}
			if (perWidth == null) {
				return {
					...box,
					w: clamp(box.w + dx, MIN_FRACTION, 1 - box.x),
					h: clamp(box.h + dy, MIN_FRACTION, 1 - box.y),
				};
			}
			// Either arrow grows or shrinks a locked shape as a whole.
			let w = clamp(box.w + dx + dy, MIN_FRACTION, 1 - box.x);
			let h = w * perWidth;
			if (box.y + h > 1) {
				h = 1 - box.y;
				w = h / perWidth;
			}
			return { ...box, w, h };
		});
	};

	/** The result's size in pixels: what is exported, from the working copy. */
	const result = (() => {
		if (!turned) return null;
		const w = turned.width * box.w;
		const h = turned.height * box.h;
		const scale = side > 0 ? Math.min(1, side / Math.max(w, h)) : 1;
		return {
			width: Math.max(1, Math.round(w * scale)),
			height: Math.max(1, Math.round(h * scale)),
		};
	})();

	const done = async () => {
		if (!turned || !result) return;
		setSaving(true);
		setError(null);
		try {
			const out = document.createElement("canvas");
			out.width = result.width;
			out.height = result.height;
			const context = out.getContext("2d");
			if (!context) throw new Error(t("adjust.cannotDraw"));
			context.imageSmoothingQuality = "high";
			context.drawImage(
				turned,
				box.x * turned.width,
				box.y * turned.height,
				box.w * turned.width,
				box.h * turned.height,
				0,
				0,
				out.width,
				out.height,
			);
			// WebP keeps photos small; browsers without it give a PNG instead.
			const blob = await new Promise<Blob | null>((resolve) =>
				out.toBlob(resolve, "image/webp", 0.95),
			);
			if (!blob) throw new Error(t("adjust.cannotSave"));
			await onDone(blob);
		} catch (problem) {
			setError(explain(problem));
		} finally {
			setSaving(false);
		}
	};

	const button =
		"rounded-md px-3 py-1.5 text-sm text-dim hover:bg-line hover:text-ink disabled:opacity-40";
	const corner = "absolute size-4 rounded-sm border-2 border-white bg-black/40";
	const shapeText = (which: Shape) =>
		which === "free"
			? t("adjust.free")
			: which === "original"
				? t("adjust.original")
				: which;

	return (
		<dialog
			ref={dialog}
			onClose={onClose}
			// While the picture is sent, closing would leave it half used.
			onCancel={(event) => saving && event.preventDefault()}
			aria-labelledby="adjust-title"
			className="m-auto max-h-[96vh] max-w-[96vw] rounded-lg border border-line bg-panel p-0 text-ink"
		>
			<div className="flex flex-col gap-3 p-4">
				<h2 id="adjust-title" className="font-display text-xl font-bold">
					{t("adjust.title")}
				</h2>
				<div
					ref={frame}
					onPointerMove={onPointerMove}
					onPointerUp={() => {
						drag.current = null;
					}}
					onPointerCancel={() => {
						drag.current = null;
					}}
					className="relative mx-auto w-fit touch-none select-none overflow-hidden"
				>
					<canvas
						ref={preview}
						className="block max-h-[60vh] max-w-full"
						role="img"
						aria-label={t("adjust.preview")}
					/>
					{turned && (
						<button
							type="button"
							aria-label={t("adjust.cropArea")}
							onKeyDown={onKey}
							onPointerDown={(event) => onPointerDown(event, "move")}
							className="absolute cursor-move border border-white/90 shadow-[0_0_0_9999px_rgb(0_0_0/0.55)] focus-visible:outline-2 focus-visible:outline-accent"
							style={{
								left: `${box.x * 100}%`,
								top: `${box.y * 100}%`,
								width: `${box.w * 100}%`,
								height: `${box.h * 100}%`,
							}}
						>
							{(["nw", "ne", "sw", "se"] as const).map((mode) => (
								<span
									key={mode}
									aria-hidden="true"
									onPointerDown={(event) => onPointerDown(event, mode)}
									className={`${corner} ${mode[0] === "n" ? "-top-2" : "-bottom-2"} ${
										mode[1] === "w" ? "-left-2" : "-right-2"
									} ${mode === "nw" || mode === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize"}`}
								/>
							))}
						</button>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-1">
					<button type="button" onClick={() => turn(-1)} className={button}>
						↺ {t("adjust.rotateLeft")}
					</button>
					<button type="button" onClick={() => turn(1)} className={button}>
						↻ {t("adjust.rotateRight")}
					</button>
					<button
						type="button"
						aria-pressed={flipped}
						onClick={() => setFlipped(!flipped)}
						className={`${button} aria-pressed:bg-line aria-pressed:text-ink`}
					>
						⇋ {t("adjust.flip")}
					</button>
					<span className="mx-2 h-5 w-px bg-line" aria-hidden="true" />
					<fieldset className="flex flex-wrap items-center gap-1">
						<legend className="sr-only">{t("adjust.crop")}</legend>
						<span className="mr-1 text-sm text-dim" aria-hidden="true">
							{t("adjust.crop")}
						</span>
						{SHAPES.map((which) => (
							<button
								key={which}
								type="button"
								aria-pressed={shape === which}
								onClick={() => reshape(which)}
								className={`${button} aria-pressed:bg-line aria-pressed:text-ink`}
							>
								{shapeText(which)}
							</button>
						))}
					</fieldset>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<label className="flex items-center gap-2 text-sm text-dim">
						{t("adjust.size")}
						<select
							value={side}
							onChange={(event) => setSide(Number(event.target.value))}
							className="rounded-md border border-line bg-bg px-2 py-1.5 text-sm"
						>
							{SIDES.map((value) => (
								<option key={value} value={value}>
									{value === 0
										? t("adjust.sizeAsIs")
										: t("adjust.sizeLongest", { size: number(value) })}
								</option>
							))}
						</select>
					</label>
					{result && (
						<span className="font-mono text-xs text-dim">
							{t("adjust.result", {
								width: number(result.width),
								height: number(result.height),
							})}
						</span>
					)}
					<button type="button" onClick={reset} className={button}>
						{t("adjust.reset")}
					</button>
					<span className="ml-auto text-sm text-danger" role="alert">
						{error}
					</span>
					<button
						type="button"
						onClick={onClose}
						className="rounded-md px-4 py-2 text-sm text-dim hover:text-ink"
					>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						onClick={done}
						disabled={!turned || saving}
						className="cta rounded-lg px-5 py-2 font-display font-bold"
					>
						{saving ? t("mask.saving") : t("adjust.done")}
					</button>
				</div>
			</div>
		</dialog>
	);
}
