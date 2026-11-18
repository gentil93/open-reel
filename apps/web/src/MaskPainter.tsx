import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";

interface Props {
	/** The picture to mark. */
	src: string;
	/** A mask marked before, to go on from. */
	mask: string | null;
	/**
	 * Gets the mask, white where the picture is redrawn and black elsewhere,
	 * and the marks as painted, to show over the picture.
	 */
	onDone(mask: Blob, marks: string): Promise<void>;
	onClose(): void;
}

/** What painting looks like over the picture; the mask itself is white. */
const PAINT = "rgb(255 61 139)";

/**
 * The longest side the marks are kept at. Models redraw at about 1024, and
 * a canvas the size of a phone photo costs hundreds of megabytes.
 */
const MAX_SIDE = 2048;

/** Whether anything is painted on the layer. */
function hasPaint(layer: HTMLCanvasElement): boolean {
	const pixels = layer
		.getContext("2d")
		?.getImageData(0, 0, layer.width, layer.height).data;
	if (!pixels) return false;
	for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) return true;
	return false;
}

/** Turns painted pixels white and the rest black, as the engine reads masks. */
function toMask(layer: HTMLCanvasElement): Promise<Blob | null> {
	const out = document.createElement("canvas");
	out.width = layer.width;
	out.height = layer.height;
	const source = layer
		.getContext("2d")
		?.getImageData(0, 0, out.width, out.height);
	const target = out.getContext("2d");
	if (!source || !target) return Promise.resolve(null);
	const pixels = source.data;
	for (let i = 0; i < pixels.length; i += 4) {
		const value = (pixels[i + 3] ?? 0) > 0 ? 255 : 0;
		pixels[i] = value;
		pixels[i + 1] = value;
		pixels[i + 2] = value;
		pixels[i + 3] = 255;
	}
	target.putImageData(source, 0, 0);
	return new Promise((resolve) => out.toBlob(resolve, "image/png"));
}

/** Paints over a picture what a model should redraw. */
export function MaskPainter({ src, mask, onDone, onClose }: Props) {
	const { t, explain } = useI18n();
	const [error, setError] = useState<string | null>(null);
	const dialog = useRef<HTMLDialogElement>(null);
	const layer = useRef<HTMLCanvasElement>(null);
	const [size, setSize] = useState(48);
	const [erasing, setErasing] = useState(false);
	const [painted, setPainted] = useState(false);
	// Painting waits for the picture, and for marks made before, to be in.
	const [ready, setReady] = useState(false);
	const [saving, setSaving] = useState(false);
	const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
	const last = useRef<{ x: number; y: number } | null>(null);

	useEffect(() => {
		dialog.current?.showModal();
	}, []);

	/** Sizes the layer to the picture, and redraws an earlier mask on it. */
	const prepare = (image: HTMLImageElement) => {
		const canvas = layer.current;
		const context = canvas?.getContext("2d");
		if (!canvas || !context) return;
		const scale = Math.min(
			1,
			MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight),
		);
		canvas.width = Math.round(image.naturalWidth * scale);
		canvas.height = Math.round(image.naturalHeight * scale);
		if (!mask) {
			setReady(true);
			return;
		}
		const earlier = new Image();
		earlier.onload = () => {
			context.drawImage(earlier, 0, 0, canvas.width, canvas.height);
			const data = context.getImageData(0, 0, canvas.width, canvas.height);
			const pixels = data.data;
			for (let i = 0; i < pixels.length; i += 4) {
				const white = (pixels[i] ?? 0) > 127;
				pixels[i] = 255;
				pixels[i + 1] = 61;
				pixels[i + 2] = 139;
				pixels[i + 3] = white ? 255 : 0;
			}
			context.putImageData(data, 0, 0);
			setPainted(true);
			setReady(true);
		};
		earlier.onerror = () => setReady(true);
		earlier.src = mask;
	};

	/** Where the pointer is, in the picture's own pixels. */
	const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
		const canvas = event.currentTarget;
		const box = canvas.getBoundingClientRect();
		return {
			x: ((event.clientX - box.left) / box.width) * canvas.width,
			y: ((event.clientY - box.top) / box.height) * canvas.height,
			scale: canvas.width / box.width,
			screen: { x: event.clientX - box.left, y: event.clientY - box.top },
		};
	};

	const stroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
		const context = event.currentTarget.getContext("2d");
		const at = point(event);
		if (!context || !ready) return;
		const from = last.current ?? at;
		context.globalCompositeOperation = erasing
			? "destination-out"
			: "source-over";
		context.strokeStyle = PAINT;
		context.lineCap = "round";
		context.lineJoin = "round";
		context.lineWidth = size * at.scale;
		context.beginPath();
		context.moveTo(from.x, from.y);
		context.lineTo(at.x, at.y);
		context.stroke();
		last.current = at;
		if (!erasing) setPainted(true);
	};

	const clear = () => {
		const canvas = layer.current;
		canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
		setPainted(false);
	};

	const done = async () => {
		if (!layer.current) return;
		setSaving(true);
		setError(null);
		try {
			const blob = await toMask(layer.current);
			if (blob) await onDone(blob, layer.current.toDataURL("image/png"));
		} catch (problem) {
			setError(explain(problem));
		} finally {
			setSaving(false);
		}
	};

	const tool = (active: boolean) =>
		`rounded-md px-3 py-1.5 text-sm ${
			active ? "bg-line text-ink" : "text-dim hover:text-ink"
		}`;

	return (
		<dialog
			ref={dialog}
			onClose={onClose}
			aria-labelledby="mask-title"
			className="m-auto max-h-[96vh] max-w-[96vw] rounded-lg border border-line bg-panel p-0 text-ink"
		>
			<div className="flex flex-col gap-3 p-4">
				<div>
					<h2 id="mask-title" className="font-display text-xl font-bold">
						{t("mask.title")}
					</h2>
					<p className="mt-1 text-sm text-dim">{t("mask.hint")}</p>
				</div>
				<div className="relative mx-auto w-fit overflow-hidden rounded-md">
					<img
						src={src}
						alt=""
						onLoad={(event) => prepare(event.currentTarget)}
						className="block max-h-[66vh] max-w-full select-none"
						draggable={false}
					/>
					<canvas
						ref={layer}
						onPointerDown={(event) => {
							event.currentTarget.setPointerCapture(event.pointerId);
							last.current = null;
							stroke(event);
						}}
						onPointerMove={(event) => {
							setCursor(point(event).screen);
							if (event.buttons === 1) stroke(event);
						}}
						onPointerUp={(event) => {
							last.current = null;
							// Erasing may leave nothing to redraw.
							if (erasing) setPainted(hasPaint(event.currentTarget));
						}}
						onPointerLeave={() => setCursor(null)}
						className="absolute inset-0 h-full w-full cursor-none touch-none opacity-55"
					/>
					{cursor && (
						<span
							aria-hidden="true"
							className="pointer-events-none absolute rounded-full border-2 border-white mix-blend-difference"
							style={{
								width: size,
								height: size,
								left: cursor.x - size / 2,
								top: cursor.y - size / 2,
							}}
						/>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<fieldset className="flex gap-1">
						<button
							type="button"
							aria-pressed={!erasing}
							onClick={() => setErasing(false)}
							className={tool(!erasing)}
						>
							{t("mask.brush")}
						</button>
						<button
							type="button"
							aria-pressed={erasing}
							onClick={() => setErasing(true)}
							className={tool(erasing)}
						>
							{t("mask.erase")}
						</button>
					</fieldset>
					<label className="flex items-center gap-2 text-sm text-dim">
						{t("mask.size")}
						<input
							type="range"
							min={8}
							max={160}
							value={size}
							onChange={(event) => setSize(Number(event.target.value))}
							className="w-28 accent-accent"
						/>
					</label>
					<button
						type="button"
						onClick={clear}
						disabled={!painted}
						className="rounded-md px-3 py-1.5 text-sm text-dim hover:text-ink disabled:opacity-40"
					>
						{t("mask.clear")}
					</button>
					<span className="ml-auto text-sm text-danger" role="alert">
						{error}
					</span>
					<div className="flex gap-2">
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
							disabled={!ready || !painted || saving}
							className="cta rounded-lg px-5 py-2 font-display font-bold"
						>
							{saving ? t("mask.saving") : t("mask.done")}
						</button>
					</div>
				</div>
			</div>
		</dialog>
	);
}
