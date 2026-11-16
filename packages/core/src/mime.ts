/**
 * The media type the bytes really are, whatever their source claimed. Null
 * when it is not one of the formats open-reel stores and shows.
 */
export function sniffMime(data: Uint8Array): string | null {
	const starts = (bytes: number[], at = 0) =>
		bytes.every((byte, i) => data[at + i] === byte);
	const ascii = (text: string, at = 0) =>
		starts(
			Array.from(text, (char) => char.charCodeAt(0)),
			at,
		);
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
	if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (ascii("RIFF") && ascii("WEBP", 8)) return "image/webp";
	if (ascii("GIF8")) return "image/gif";
	// ISO media: a box size, then "ftyp". QuickTime files use the same layout.
	if (ascii("ftyp", 4)) {
		return ascii("qt  ", 8) ? "video/quicktime" : "video/mp4";
	}
	if (starts([0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
	return null;
}
