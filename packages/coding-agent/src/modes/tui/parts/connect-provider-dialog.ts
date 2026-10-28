import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	MouseRegion,
	Spacer,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@huranth/gama-tui";
import { theme } from "../theme/theme.ts";

export interface ConnectProviderInput {
	baseUrl: string;
	apiKey: string;
}

type Field = "baseUrl" | "apiKey";

export interface ConnectProviderDialogOptions {
	onContinue: (input: ConnectProviderInput) => void;
	onCancel: () => void;
	initialBaseUrl?: string;
	initialApiKey?: string;
	title?: string;
	submitLabel?: string;
	apiKeyPlaceholder?: string;
	apiKeyHint?: string;
	baseUrlOptional?: boolean;
}

export class ConnectProviderDialogComponent extends Container implements Focusable {
	private readonly baseUrlInput: Input;
	private readonly apiKeyInput: Input;
	private readonly continueText: Text;
	private readonly errorText: Text;
	private activeField: Field | undefined;
	private continuePressed = false;
	private errorMessage?: string;
	private readonly onContinue: (input: ConnectProviderInput) => void;
	private readonly onCancel: () => void;
	private readonly submitLabel: string;
	private readonly baseUrlOptional: boolean;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}

	constructor(options: ConnectProviderDialogOptions) {
		super();
		this.onContinue = options.onContinue;
		this.onCancel = options.onCancel;
		this.submitLabel = options.submitLabel ?? "Continue";
		this.baseUrlOptional = options.baseUrlOptional === true;

		this.addChild(new Text(theme.bold(options.title ?? "Connect a provider"), 0, 0));
		this.addChild(new Spacer(1));

		this.baseUrlInput = new Input();
		if (options.initialBaseUrl) {
			this.baseUrlInput.setValue(options.initialBaseUrl);
		}
		this.baseUrlInput.onSubmit = () => this.advanceFrom("baseUrl");
		this.baseUrlInput.onEscape = () => this.cancel();
		this.addChild(new Text(theme.fg("muted", "Base URL"), 0, 0));
		this.addChild(this.baseUrlInput);
		this.addChild(new Spacer(1));

		this.apiKeyInput = new Input({ placeholder: options.apiKeyPlaceholder, mask: true });
		if (options.initialApiKey) {
			this.apiKeyInput.setValue(options.initialApiKey);
		}
		this.apiKeyInput.onSubmit = () => this.advanceFrom("apiKey");
		this.apiKeyInput.onEscape = () => this.cancel();
		this.addChild(new Text(theme.fg("muted", "API key"), 0, 0));
		this.addChild(this.apiKeyInput);
		if (options.apiKeyHint) {
			this.addChild(new Text(theme.fg("muted", options.apiKeyHint), 0, 0));
		}
		this.addChild(new Spacer(1));

		this.continueText = new Text(this.renderContinue(), 0, 0);
		this.addChild(new MouseRegion(this.continueText, (event) => this.handleButtonMouse(event)));

		this.errorText = new Text("", 0, 0);
		this.addChild(this.errorText);

		this.syncFocus();
	}

	private activeInput(): Input {
		return this.activeField === "apiKey" ? this.apiKeyInput : this.baseUrlInput;
	}

	private syncFocus(): void {
		this.baseUrlInput.focused = this._focused && this.activeField === "baseUrl";
		this.apiKeyInput.focused = this._focused && this.activeField === "apiKey";
	}

	private renderContinue(): string {
		const label = this.submitLabel;
		if (this.errorMessage) return theme.fg("error", label);
		if (this.continuePressed) return theme.fg("accent", theme.bold(label));
		const enabled = this.baseUrlOptional || this.baseUrlInput.getValue().trim() !== "";
		return enabled ? theme.fg("accent", label) : theme.fg("muted", label);
	}

	private refresh(): void {
		this.continueText.setText(this.renderContinue());
		this.errorText.setText(this.errorMessage ? theme.fg("error", this.errorMessage) : "");
	}

	private setActiveField(field: Field): void {
		this.activeField = field;
		this.syncFocus();
		this.refresh();
	}

	private advanceFrom(field: Field): void {
		this.errorMessage = undefined;
		if (field === "baseUrl") {
			if (!this.baseUrlOptional && this.baseUrlInput.getValue().trim() === "") {
				this.errorMessage = "Enter a base URL.";
				this.refresh();
				return;
			}
			this.setActiveField("apiKey");
			return;
		}
		this.submit();
	}

	private submit(): void {
		const baseUrl = this.baseUrlInput.getValue().trim();
		const apiKey = this.apiKeyInput.getValue().trim();
		if (!this.baseUrlOptional && baseUrl === "") {
			this.errorMessage = "Enter a base URL.";
			this.setActiveField("baseUrl");
			return;
		}
		this.onContinue({ baseUrl, apiKey });
	}

	private cancel(): void {
		this.onCancel();
	}

	private fieldRow(field: Field, width: number): { start: number; end: number } | undefined {
		const target = field === "baseUrl" ? this.baseUrlInput : this.apiKeyInput;
		let y = 0;
		for (const child of this.children) {
			const height = child.render(width).length;
			if (child === target) return { start: y, end: y + height };
			y += height;
		}
		return undefined;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.button === "left" && (event.type === "press" || event.type === "click")) {
			for (const field of ["baseUrl", "apiKey"] as const) {
				const row = this.fieldRow(field, event.width);
				if (row && event.y >= row.start && event.y < row.end) {
					this.setActiveField(field);
				}
			}
		}
		return super.handleMouse(event);
	}

	private handleButtonMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		if (event.type === "press") {
			this.continuePressed = true;
			this.refresh();
			return { handled: true, render: true };
		}
		if (event.type === "click") {
			this.continuePressed = false;
			this.refresh();
			this.submit();
			return { handled: true, render: true };
		}
		if (event.type === "move" || event.type === "release") {
			if (this.continuePressed) {
				this.continuePressed = false;
				this.refresh();
				return { handled: true, render: true };
			}
		}
		return undefined;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		if (kb.matches(data, "tui.input.tab") || data === "\x1b[Z") {
			if (this.activeField === undefined) {
				this.setActiveField("baseUrl");
			} else {
				this.setActiveField(this.activeField === "baseUrl" ? "apiKey" : "baseUrl");
			}
			return;
		}
		if (this.activeField === undefined) this.setActiveField("baseUrl");
		this.activeInput().handleInput(data);
		this.refresh();
	}
}
