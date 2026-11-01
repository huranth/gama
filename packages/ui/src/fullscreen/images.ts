import { deleteKittyImage, getKittyImagePlacement } from "../terminal-image.ts";

export interface CachedKittyImage {
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
}

const maxCachedOffscreenKittyImages = 16;

const maxCachedOffscreenKittyTransmissionBytes = 32 * 1024 * 1024;

const maxCachedOffscreenKittyDecodedBytes = 64 * 1024 * 1024;

interface PreparedKittyScreen {
	lines: string[];
	evictedImageDeletion: string;
}

interface OffscreenUsage {
	count: number;
	transmissionBytes: number;
	decodedBytes: number;
}

export class KittyImageCache {
	private readonly images = new Map<number, CachedKittyImage>();

	get size(): number {
		return this.images.size;
	}

	clear(): void {
		this.images.clear();
	}

	prepare(screen: readonly string[]): PreparedKittyScreen {
		const visibleImageIds = new Set<number>();
		const lines = screen.map((line) => {
			const placement = getKittyImagePlacement(line);
			if (!placement) return line;
			visibleImageIds.add(placement.imageId);

			const cachedImage = this.images.get(placement.imageId);
			const nextCachedImage = {
				transmissionGeneration: placement.transmissionGeneration,
				transmissionBytes: placement.transmissionBytes,
				estimatedDecodedBytes: placement.estimatedDecodedBytes,
			};
			if (cachedImage) this.images.delete(placement.imageId);
			this.images.set(placement.imageId, nextCachedImage);

			return cachedImage?.transmissionGeneration === placement.transmissionGeneration
				? placement.replacementLine
				: line;
		});

		let usage = this.measureOffscreen(visibleImageIds);
		let evictedImageDeletion = "";
		for (const [imageId, cachedImage] of this.images) {
			if (this.withinQuota(usage)) break;
			if (visibleImageIds.has(imageId)) continue;
			evictedImageDeletion += deleteKittyImage(imageId);
			this.images.delete(imageId);
			usage = {
				count: usage.count - 1,
				transmissionBytes: usage.transmissionBytes - cachedImage.transmissionBytes,
				decodedBytes: usage.decodedBytes - cachedImage.estimatedDecodedBytes,
			};
		}
		return { lines, evictedImageDeletion };
	}

	private measureOffscreen(visibleImageIds: Set<number>): OffscreenUsage {
		const usage: OffscreenUsage = { count: 0, transmissionBytes: 0, decodedBytes: 0 };
		for (const [imageId, cachedImage] of this.images) {
			if (visibleImageIds.has(imageId)) continue;
			usage.count += 1;
			usage.transmissionBytes += cachedImage.transmissionBytes;
			usage.decodedBytes += cachedImage.estimatedDecodedBytes;
		}
		return usage;
	}

	private withinQuota(usage: OffscreenUsage): boolean {
		return (
			usage.count <= maxCachedOffscreenKittyImages &&
			usage.transmissionBytes <= maxCachedOffscreenKittyTransmissionBytes &&
			usage.decodedBytes <= maxCachedOffscreenKittyDecodedBytes
		);
	}
}
