export const MAX_HISTORY = 100;

export interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

export interface EditorSnapshot {
	state: EditorState;
	pastes: Map<number, string>;
	pasteCounter: number;
}
