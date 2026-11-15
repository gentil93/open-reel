export function duration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function usd(value: number): string {
	return `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
}
