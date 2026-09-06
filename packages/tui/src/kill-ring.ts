export class KillRing {
	private ring: string[] = [];

	push(text: string, options: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;

		if (!options.accumulate || this.ring.length === 0) {
			this.ring.push(text);
			return;
		}

		const previous = this.ring.pop();
		if (previous === undefined) return;

		this.ring.push(options.prepend ? text + previous : previous + text);
	}

	peek(): string | undefined {
		return this.ring[this.ring.length - 1];
	}

	rotate(): void {
		if (this.ring.length <= 1) return;

		const last = this.ring.pop();
		if (last === undefined) return;

		this.ring.unshift(last);
	}

	get length(): number {
		return this.ring.length;
	}
}
