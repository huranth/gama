export const MAX_UNDO_DEPTH = 200;

export class UndoStack<S> {
	private stack: S[] = [];

	push(state: S): void {
		this.stack.push(structuredClone(state));
		if (this.stack.length > MAX_UNDO_DEPTH) this.stack.shift();
	}

	pop(): S | undefined {
		return this.stack.pop();
	}

	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
