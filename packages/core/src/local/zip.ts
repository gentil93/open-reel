import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";

/** One file in a zip archive, as its central directory describes it. */
interface Entry {
	name: string;
	method: number;
	crc: number;
	compressedSize: number;
	size: number;
	headerOffset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const UINT32_MAX = 0xffffffff;

async function readAt(
	file: Awaited<ReturnType<typeof open>>,
	position: number,
	length: number,
): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await file.read(buffer, 0, length, position);
	if (bytesRead !== length) throw new Error("The archive is truncated");
	return buffer;
}

/** Reads the list of files from the end of the archive. */
async function readEntries(
	file: Awaited<ReturnType<typeof open>>,
	fileSize: number,
): Promise<Entry[]> {
	// The end record is 22 bytes, followed by a comment of up to 64 kB.
	const tailLength = Math.min(fileSize, 22 + 0xffff);
	const tail = await readAt(file, fileSize - tailLength, tailLength);
	let end = -1;
	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail.readUInt32LE(i) === EOCD) {
			end = i;
			break;
		}
	}
	if (end === -1) throw new Error("Not a zip archive");

	let count = tail.readUInt16LE(end + 10);
	let directorySize = tail.readUInt32LE(end + 12);
	let directoryOffset = tail.readUInt32LE(end + 16);
	const locator = end - 20;
	if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR) {
		const at = Number(tail.readBigUInt64LE(locator + 8));
		const record = await readAt(file, at, 56);
		if (record.readUInt32LE(0) !== ZIP64_EOCD) {
			throw new Error("The archive's zip64 record is damaged");
		}
		count = Number(record.readBigUInt64LE(32));
		directorySize = Number(record.readBigUInt64LE(40));
		directoryOffset = Number(record.readBigUInt64LE(48));
	}
	if (directoryOffset + directorySize > fileSize) {
		throw new Error("The archive is truncated");
	}

	const directory = await readAt(file, directoryOffset, directorySize);
	const entries: Entry[] = [];
	let at = 0;
	for (let i = 0; i < count; i++) {
		if (directory.readUInt32LE(at) !== CENTRAL_HEADER) {
			throw new Error("The archive's file list is damaged");
		}
		const nameLength = directory.readUInt16LE(at + 28);
		const extraLength = directory.readUInt16LE(at + 30);
		const commentLength = directory.readUInt16LE(at + 32);
		let compressedSize = directory.readUInt32LE(at + 20);
		let size = directory.readUInt32LE(at + 24);
		let headerOffset = directory.readUInt32LE(at + 42);

		// Values too large for 32 bits are in the zip64 extra field, in order.
		let extra = at + 46 + nameLength;
		const extraEnd = extra + extraLength;
		while (extra + 4 <= extraEnd) {
			const id = directory.readUInt16LE(extra);
			const length = directory.readUInt16LE(extra + 2);
			if (id === 0x0001) {
				let field = extra + 4;
				const next = () => {
					const value = Number(directory.readBigUInt64LE(field));
					field += 8;
					return value;
				};
				if (size === UINT32_MAX) size = next();
				if (compressedSize === UINT32_MAX) compressedSize = next();
				if (headerOffset === UINT32_MAX) headerOffset = next();
			}
			extra += 4 + length;
		}

		entries.push({
			name: directory.toString("utf8", at + 46, at + 46 + nameLength),
			method: directory.readUInt16LE(at + 10),
			crc: directory.readUInt32LE(at + 16),
			compressedSize,
			size,
			headerOffset,
		});
		at += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** Where an entry goes under `dir`, refusing names that would leave it. */
function target(dir: string, name: string): string {
	const parts = name.replaceAll("\\", "/").split("/");
	if (
		name.startsWith("/") ||
		/^[a-zA-Z]:/.test(name) ||
		parts.some((part) => part === "..")
	) {
		throw new Error(`The archive holds an unsafe path: ${name}`);
	}
	const path = join(
		dir,
		...parts.filter((part) => part !== "" && part !== "."),
	);
	if (path !== dir && !path.startsWith(dir + sep)) {
		throw new Error(`The archive holds an unsafe path: ${name}`);
	}
	return path;
}

/** Checks size and CRC-32 of what passes through, as the archive lists them. */
function verify(entry: Entry): Transform {
	let crc = 0;
	let size = 0;
	return new Transform({
		transform(chunk: Buffer, _, done) {
			crc = crc32(chunk, crc);
			size += chunk.length;
			if (size > entry.size) {
				done(new Error(`${entry.name} is larger than the archive says`));
				return;
			}
			done(null, chunk);
		},
		flush(done) {
			if (size !== entry.size || crc !== entry.crc) {
				done(new Error(`${entry.name} is damaged in the archive`));
				return;
			}
			done();
		},
	});
}

/**
 * Extracts a zip archive into `dir`, streaming each file. Only stored and
 * deflated entries are supported, which is what zip tools write by default.
 */
export async function extractZip(archive: string, dir: string): Promise<void> {
	const file = await open(archive, "r");
	try {
		const { size: fileSize } = await file.stat();
		const entries = await readEntries(file, fileSize);
		await mkdir(dir, { recursive: true });
		for (const entry of entries) {
			const path = target(dir, entry.name);
			if (entry.name.endsWith("/")) {
				await mkdir(path, { recursive: true });
				continue;
			}
			if (entry.method !== 0 && entry.method !== 8) {
				throw new Error(
					`${entry.name} uses a compression method that is not supported`,
				);
			}
			const header = await readAt(file, entry.headerOffset, 30);
			if (header.readUInt32LE(0) !== LOCAL_HEADER) {
				throw new Error("The archive is damaged");
			}
			const start =
				entry.headerOffset +
				30 +
				header.readUInt16LE(26) +
				header.readUInt16LE(28);
			if (start + entry.compressedSize > fileSize) {
				throw new Error("The archive is truncated");
			}

			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.${crypto.randomUUID()}.tmp`;
			const out = await open(tmp, "w");
			try {
				const source = Readable.from(
					(async function* () {
						const chunkSize = 1 << 20;
						for (let at = 0; at < entry.compressedSize; at += chunkSize) {
							const length = Math.min(chunkSize, entry.compressedSize - at);
							yield await readAt(file, start + at, length);
						}
					})(),
				);
				const steps =
					entry.method === 8
						? [createInflateRaw(), verify(entry)]
						: [verify(entry)];
				await pipeline(source, ...steps, out.createWriteStream());
			} catch (error) {
				await rm(tmp, { force: true });
				throw error;
			} finally {
				await out.close().catch(() => {});
			}
			await rename(tmp, path);
		}
	} finally {
		await file.close();
	}
}
