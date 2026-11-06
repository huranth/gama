import { lookup } from "node:dns/promises";
import net from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";

// DNS resolver
export type HostLookup = (hostname: string) => Promise<string[]>;

// Address policy
export type AddressPolicy = (ip: string) => boolean;

// Host allowlist
export interface HostPolicy {
	allows(host: string): boolean;
}

type LookupCallback = (
	error: NodeJS.ErrnoException | null,
	address: string | LookupAddress[],
	family?: number,
) => void;

// Ssrf error
export class SsrfError extends Error {
	readonly host?: string;
	readonly address?: string;

	constructor(message: string, options?: { host?: string; address?: string }) {
		super(message);
		this.name = "SsrfError";
		this.host = options?.host;
		this.address = options?.address;
	}
}

// Default lookup
export const defaultLookup: HostLookup = async (hostname) => {
	const results = await lookup(hostname, { all: true, verbatim: true });
	return results.map((result) => result.address);
};

// IP families
const IPV4 = 4;

const IPV6 = 6;

// IPv4 parts
const IPV4_PARTS = 4;

// Octet range
const OCTET_BASE = 256;

const MAX_OCTET = OCTET_BASE - 1;

// Numeric bases
const HEX_BASE = 16;

const OCTAL_BASE = 8;

const DECIMAL_BASE = 10;

// Mapped prefix
const MAPPED_PREFIX = "(?:::ffff:|(?:0{1,4}:){5}ffff:)";

const MAPPED_DOTTED = new RegExp(`^${MAPPED_PREFIX}(\\d+\\.\\d+\\.\\d+\\.\\d+)$`, "i");

const MAPPED_HEX = new RegExp(`^${MAPPED_PREFIX}([0-9a-f]{1,4}):([0-9a-f]{1,4})$`, "i");

const MAPPED_ZERO = new RegExp(`^${MAPPED_PREFIX}0:`, "i");

// IPv4 ranges
const IPV4_BLOCKS: ReadonlyArray<[string, number]> = [
	["0.0.0.0", 8], // This network
	["10.0.0.0", 8], // RFC 1918
	["100.64.0.0", 10], // CGNAT
	["127.0.0.0", 8], // Loopback
	["169.254.0.0", 16], // Link-local
	["172.16.0.0", 12], // RFC 1918
	["192.0.0.0", 24], // Protocol assignments
	["192.0.2.0", 24], // Testnet 1
	["192.88.99.0", 24], // 6to4 relay
	["192.168.0.0", 16], // RFC 1918
	["198.18.0.0", 15], // Benchmarking
	["198.51.100.0", 24], // Testnet 2
	["203.0.113.0", 24], // Testnet 3
	["224.0.0.0", 4], // Multicast
	["240.0.0.0", 4], // Reserved, broadcast
];

// IPv6 ranges
const IPV6_BLOCKS: ReadonlyArray<[string, number]> = [
	["::", 96], // Reserved v6
	["64:ff9b::", 96], // NAT64 known
	["64:ff9b:1::", 48], // NAT64 local
	["100::", 64], // Discard-only
	["2001::", 23], // IETF assignments
	["2001:db8::", 32], // Documentation
	["2002::", 16], // 6to4
	["3fff::", 20], // Documentation
	["5f00::", 16], // SRv6
	["fc00::", 7], // Unique-local
	["fe80::", 10], // Link-local
	["fec0::", 10], // Site-local
	["ff00::", 8], // Multicast
];

// Subnet list
function blockListOf(
	blocks: ReadonlyArray<[string, number]>,
	family: "ipv4" | "ipv6",
): net.BlockList {
	const list = new net.BlockList();

	for (const [address, prefix] of blocks) {
		list.addSubnet(address, prefix, family);
	}

	return list;
}

const BLOCKED_IPV4 = blockListOf(IPV4_BLOCKS, "ipv4");

const BLOCKED_IPV6 = blockListOf(IPV6_BLOCKS, "ipv6");

// Bracket split
function splitBrackets(value: string): { inner: string; rest: string } | undefined {
	if (!value.startsWith("[")) return undefined;

	const close = value.indexOf("]");
	if (close === -1) return undefined;

	return { inner: value.slice(1, close), rest: value.slice(close + 1) };
}

// Bracket unwrap
export function unwrapHost(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

// Host normalize
function normalizeHost(host: string): string {
	let value = host.trim().toLowerCase();
	const parts = splitBrackets(value);

	if (parts) value = parts.inner;
	else if (value.startsWith("[")) value = value.slice(1);
	else if (value.includes(":") && net.isIP(value) !== IPV6)
		value = value.slice(0, value.indexOf(":"));

	return value.replace(/\.+$/, "");
}

// Numeric part
function parseHostNumber(part: string): number | undefined {
	if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part.slice(2), HEX_BASE);

	if (part.length > 1 && /^0[0-7]+$/.test(part)) {
		return Number.parseInt(part.slice(1), OCTAL_BASE);
	}

	if (/^\d+$/.test(part)) return Number.parseInt(part, DECIMAL_BASE);
	return undefined;
}

// Dotted form
function octetsToDotted(value: number): string {
	const a = (value >>> 24) & MAX_OCTET;
	const b = (value >>> 16) & MAX_OCTET;
	const c = (value >>> 8) & MAX_OCTET;
	return `${a}.${b}.${c}.${value & MAX_OCTET}`;
}

// To dotted
export function decodeIpv4Literal(host: string): string | undefined {
	const parts = host.split(".");
	if (parts.length > IPV4_PARTS) return undefined;

	const numbers: number[] = [];
	for (const part of parts) {
		const value = parseHostNumber(part);
		if (value === undefined) return undefined;
		numbers.push(value);
	}

	// Byte cap
	for (let i = 0; i < parts.length - 1; i++) {
		if (numbers[i]! > MAX_OCTET) return undefined;
	}

	// Last absorbs
	const span = IPV4_PARTS + 1 - parts.length;
	const last = numbers[parts.length - 1]!;
	if (last >= OCTET_BASE ** span) return undefined;

	// Assemble
	let value = 0;
	for (let i = 0; i < parts.length - 1; i++) value = value * OCTET_BASE + numbers[i]!;
	value = value * OCTET_BASE ** span + last;
	return octetsToDotted(value);
}

// V4 unwrap
function mappedIpv4(ip: string): string | undefined {
	const dotted = MAPPED_DOTTED.exec(ip)?.[1];
	if (dotted) return dotted;

	const hex = MAPPED_HEX.exec(ip);
	if (!hex) return undefined;

	const high = Number.parseInt(hex[1]!, HEX_BASE);
	const low = Number.parseInt(hex[2]!, HEX_BASE);
	return `${high >>> 8}.${high & MAX_OCTET}.${low >>> 8}.${low & MAX_OCTET}`;
}

// Public check
export function isBlockedAddress(ip: string): boolean {
	const zone = ip.indexOf("%");
	const address = zone === -1 ? ip : ip.slice(0, zone);
	const family = net.isIP(address);
	if (family === 0) return true;

	if (family === IPV4) return BLOCKED_IPV4.check(address, "ipv4");

	// Canonical spelling
	let normalized: string;
	try {
		normalized = unwrapHost(new URL(`http://[${address}]/`).hostname);
	} catch {
		return true;
	}

	// Mapped v4
	const mapped = mappedIpv4(normalized);
	if (mapped) {
		return net.isIP(mapped) !== IPV4 || BLOCKED_IPV4.check(mapped, "ipv4");
	}

	// Hand match
	if (MAPPED_ZERO.test(normalized)) return true;

	return BLOCKED_IPV6.check(normalized, "ipv6");
}

// Resolve message
function resolveMessage(reason?: string): string {
	const message = "Unknown host";
	return reason === undefined ? message : `${message}: ${reason}`;
}

// Hop gate
export async function resolveAllowedAddresses(
	host: string,
	options: { lookupHost?: HostLookup; isBlocked?: AddressPolicy } = {},
): Promise<string[]> {
	const lookupHost = options.lookupHost ?? defaultLookup;
	const isBlocked = options.isBlocked ?? isBlockedAddress;

	let addresses: string[];
	try {
		addresses = await lookupHost(host);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "unknown error";
		throw new SsrfError(resolveMessage(reason), { host });
	}

	if (addresses.length === 0) {
		throw new SsrfError(resolveMessage(), { host });
	}

	for (const address of addresses) {
		if (!isBlocked(address)) continue;

		const reason = `Blocked address: ${address}`;
		throw new SsrfError(reason, { host, address });
	}

	return addresses;
}

// Hop gate
export async function assertUrlAllowed(
	url: URL,
	options: {
		lookupHost?: HostLookup;
		resolveDns?: boolean;
		isBlocked?: AddressPolicy;
		allowlist?: HostPolicy;
	} = {},
): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SsrfError("Only http:// and https:// URLs are supported");
	}

	if (url.username || url.password) {
		throw new SsrfError("URLs with credentials are not supported");
	}

	const host = normalizeHost(url.hostname);
	const isBlocked = options.isBlocked ?? isBlockedAddress;

	if (options.allowlist && !options.allowlist.allows(host)) {
		throw new SsrfError(`Host "${host}" is not on the allowlist`, { host });
	}

	// No DNS
	const literal = net.isIP(host) !== 0 ? host : decodeIpv4Literal(host);
	if (literal) {
		if (isBlocked(literal)) {
			throw new SsrfError(`Blocked address: ${literal}`, {
				address: literal,
			});
		}
		return;
	}

	if (options.resolveDns === false) return;

	await resolveAllowedAddresses(host, { lookupHost: options.lookupHost, isBlocked });
}

// Socket lookup
export function validatingLookup(options: { lookupHost?: HostLookup; isBlocked?: AddressPolicy }) {
	return (hostname: string, lookupOptions: LookupOptions, callback: LookupCallback): void => {
		resolveAllowedAddresses(hostname, options).then(
			(addresses) => {
				const family = lookupOptions?.family;
				const wanted = family === IPV4 || family === IPV6 ? family : 0;

				const entries = addresses
					.map((address) => ({ address, family: net.isIP(address) }))
					.filter((entry) => entry.family !== 0)
					.filter((entry) => wanted === 0 || entry.family === wanted);

				if (entries.length === 0) {
					const error: NodeJS.ErrnoException = new Error(resolveMessage(hostname));
					error.code = "ENOTFOUND";
					callback(error, "", 0);
					return;
				}

				if (lookupOptions?.all) callback(null, entries);
				else callback(null, entries[0]!.address, entries[0]!.family);
			},
			(error: unknown) =>
				callback(error instanceof Error ? error : new Error(String(error)), "", 0),
		);
	};
}

// Pattern error
function badPattern(): Error {
	return new Error("Bad pattern");
}

function compilePattern(pattern: string, denylist: boolean): (host: string) => boolean {
	const source = pattern.trim().toLowerCase();
	if (/[{}\\/\s]/.test(source)) throw badPattern();
	if (source.includes("[") && !source.startsWith("[")) throw badPattern();

	let value = source.endsWith(".") ? source.slice(0, -1) : source;

	// Bracketed v6
	if (value.startsWith("[")) {
		const parts = splitBrackets(value);
		if (!parts) throw badPattern();

		if (parts.rest !== "" && !/^:\d*$/.test(parts.rest)) throw badPattern();

		if (parts.inner === "*") {
			if (parts.rest !== "") throw badPattern();
			return () => true;
		}

		if (net.isIP(parts.inner) !== IPV6) throw badPattern();
		return (host) => normalizeHost(host) === parts.inner;
	}

	// Every host
	if (value === "*") {
		if (denylist) throw new Error("Bad pattern");
		return () => true;
	}

	// Root subs
	if (value.startsWith("**.")) {
		const rest = value.slice(3);
		if (rest.includes("*")) throw badPattern();

		return (host) => {
			const normalized = normalizeHost(host);
			return normalized === rest || normalized.endsWith(`.${rest}`);
		};
	}

	// Subs only
	if (value.startsWith("*.")) {
		const rest = value.slice(2);
		if (rest.includes("*")) throw badPattern();
		return (host) => normalizeHost(host).endsWith(`.${rest}`);
	}

	if (value.includes("*")) throw badPattern();

	// Single char
	if (value.includes("?")) {
		const regexSource = [...value]
			.map((char) => (char === "?" ? "[^.]" : char.replace(/[.*+^${}()|[\]\\]/g, "\\$&")))
			.join("");
		const regex = new RegExp(`^${regexSource}$`);
		return (host) => regex.test(normalizeHost(host));
	}

	return (host) => normalizeHost(host) === value;
}

// Wildcard grammar
export function compileAllowlist(
	patterns: readonly string[],
	options?: { denylist?: boolean },
): HostPolicy {
	const denylist = options?.denylist ?? false;
	const matchers = patterns.map((pattern) => compilePattern(pattern, denylist));

	return {
		allows(host: string) {
			return matchers.some((matcher) => matcher(host));
		},
	};
}
