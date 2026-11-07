const bomChar = "\uFEFF";

export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith(bomChar)
		? { bom: bomChar, text: content.slice(bomChar.length) }
		: { bom: "", text: content };
}

export function stripBom(content: string): string {
	return splitBom(content).text;
}
