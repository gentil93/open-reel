import { crc32, deflateRawSync } from "node:zlib";

export interface ZipItem {
	name: string;
	data?: Uint8Array;
	/** 0 stores the bytes, 8 deflates them. */
	method?: number;
	/** Overrides what the archive claims, to make a damaged one. */
	crc?: number;
}

/** Writes a zip archive the way common tools do. */
export function zip(
	items: ZipItem[],
	options: { zip64?: boolean } = {},
): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const item of items) {
		const data = Buffer.from(item.data ?? new Uint8Array());
		const method = item.method ?? 8;
		const body = method === 8 ? deflateRawSync(data) : data;
		const name = Buffer.from(item.name);
		const crc = item.crc ?? crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, body);

		const extra = options.zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
		if (options.zip64) {
			extra.writeUInt16LE(0x0001, 0);
			extra.writeUInt16LE(24, 2);
			extra.writeBigUInt64LE(BigInt(data.length), 4);
			extra.writeBigUInt64LE(BigInt(body.length), 12);
			extra.writeBigUInt64LE(BigInt(offset), 20);
		}
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(options.zip64 ? 0xffffffff : body.length, 20);
		central.writeUInt32LE(options.zip64 ? 0xffffffff : data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(extra.length, 30);
		central.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 42);
		centrals.push(central, name, extra);
		offset += local.length + name.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(items.length, 8);
	end.writeUInt16LE(items.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
