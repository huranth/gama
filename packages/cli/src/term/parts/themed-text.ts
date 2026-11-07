import { Text } from "@huranth/gama-tui";

export class ThemedText extends Text {
	private readonly build: () => string;
	private stale = true;

	constructor(build: () => string, paddingX = 1, paddingY = 1) {
		super("", paddingX, paddingY);
		this.build = build;
	}

	override invalidate(): void {
		super.invalidate();
		this.stale = true;
	}

	override render(width: number): string[] {
		if (this.stale) {
			this.stale = false;
			this.setText(this.build());
		}
		return super.render(width);
	}
}
