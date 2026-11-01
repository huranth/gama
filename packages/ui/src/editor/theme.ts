import type { SelectListTheme } from "../view/select-list.ts";

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}
