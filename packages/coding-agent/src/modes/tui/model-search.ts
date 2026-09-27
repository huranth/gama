export interface ModelSearchItem {
	id: string;
	provider: string;
	name?: string;
}

export function getModelSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${provider}/${id} ${id}${name}`;
}

export function getModelSelectorSearchText(item: ModelSearchItem): string {
	return getModelSearchText(item);
}
