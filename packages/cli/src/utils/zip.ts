import { writeFile } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";

interface ZipEntry {
	name: string;
	data: string | Uint8Array;
}

interface ZipHeaderFields {
	checksum: number;
	compressedSize: number;
	size: number;
	nameLength: number;
	time: number;
	day: number;
}

const localFileSignature = 0x04034b50;

const centralFileSignature = 0x02014b50;

const endRecordSignature = 0x06054b50;

const zipVersion = 20;

const utf8Flag = 0x0800;

const deflateMethod = 8;

const localHeaderLength = 30;

const centralHeaderLength = 46;

const endRecordLength = 22;

const dosEpochYear = 1980;

export function writeZipArchive(filePath: string, entries: readonly ZipEntry[]): Promise<void> {
	return writeFile(filePath, createZipArchive(entries), { mode: 0o600 });
}

function dosDateTime(date: Date): { time: number; day: number } {
	const year = Math.max(dosEpochYear, date.getFullYear()) - dosEpochYear;
	const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
	const day = (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

	return { time, day };
}

function writeLocalHeader(fields: ZipHeaderFields): Buffer {
	const header = Buffer.alloc(localHeaderLength);
	let offset = 0;

	const uint16 = (value: number) => {
		header.writeUInt16LE(value, offset);
		offset += 2;
	};

	const uint32 = (value: number) => {
		header.writeUInt32LE(value, offset);
		offset += 4;
	};

	uint32(localFileSignature);
	uint16(zipVersion);
	uint16(utf8Flag);
	uint16(deflateMethod);
	uint16(fields.time);
	uint16(fields.day);
	uint32(fields.checksum);
	uint32(fields.compressedSize);
	uint32(fields.size);
	uint16(fields.nameLength);

	return header;
}

function writeCentralHeader(fields: ZipHeaderFields, fileOffset: number): Buffer {
	const header = Buffer.alloc(centralHeaderLength);
	let offset = 0;

	const uint16 = (value: number) => {
		header.writeUInt16LE(value, offset);
		offset += 2;
	};

	const uint32 = (value: number) => {
		header.writeUInt32LE(value, offset);
		offset += 4;
	};

	uint32(centralFileSignature);
	uint16(zipVersion);
	uint16(zipVersion);
	uint16(utf8Flag);
	uint16(deflateMethod);
	uint16(fields.time);
	uint16(fields.day);
	uint32(fields.checksum);
	uint32(fields.compressedSize);
	uint32(fields.size);
	uint16(fields.nameLength);

	// Padding fields
	uint16(0);
	uint16(0);
	uint16(0);
	uint16(0);
	uint32(0);
	uint32(fileOffset);

	return header;
}

function writeEndRecord(
	entryCount: number,
	directorySize: number,
	directoryOffset: number,
): Buffer {
	const record = Buffer.alloc(endRecordLength);
	let offset = 0;

	const uint16 = (value: number) => {
		record.writeUInt16LE(value, offset);
		offset += 2;
	};

	const uint32 = (value: number) => {
		record.writeUInt32LE(value, offset);
		offset += 4;
	};

	uint32(endRecordSignature);
	uint16(0);
	uint16(0);
	uint16(entryCount);
	uint16(entryCount);
	uint32(directorySize);
	uint32(directoryOffset);
	uint16(0);

	return record;
}

function createZipArchive(entries: readonly ZipEntry[]): Buffer {
	const files: Buffer[] = [];
	const directory: Buffer[] = [];
	const { time, day } = dosDateTime(new Date());
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const data = Buffer.from(entry.data);
		const compressed = deflateRawSync(data);
		const fields: ZipHeaderFields = {
			checksum: crc32(data),
			compressedSize: compressed.length,
			size: data.length,
			nameLength: name.length,
			time,
			day,
		};

		const local = writeLocalHeader(fields);
		const central = writeCentralHeader(fields, offset);

		files.push(local, name, compressed);
		directory.push(central, name);
		offset += local.length + name.length + compressed.length;
	}

	const centralDirectory = Buffer.concat(directory);
	const end = writeEndRecord(entries.length, centralDirectory.length, offset);

	return Buffer.concat([...files, centralDirectory, end]);
}
