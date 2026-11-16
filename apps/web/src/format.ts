export function duration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function usd(value: number): string {
	return `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
}

/** Sizes in the decimal units disks and download pages use. */
export function bytes(value: number): string {
	if (value < 1e6) return `${Math.round(value / 1e3)} kB`;
	if (value < 1e9) return `${Math.round(value / 1e6)} MB`;
	return `${(value / 1e9).toFixed(value < 1e10 ? 2 : 1)} GB`;
}

/** A rough time left, for long downloads. */
export function remaining(seconds: number): string {
	if (seconds < 60) return "less than a minute left";
	if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
	const hours = Math.floor(seconds / 3600);
	return `${hours} h ${Math.round((seconds % 3600) / 60)} min left`;
}
