import {
	type ContextEditEntry,
	generateId,
	type LabelEntry,
	type SessionEntry,
} from "./entries.ts";

export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

export function buildEntryIndex(
	entries: SessionEntry[],
	byId?: Map<string, SessionEntry>,
): Map<string, SessionEntry> {
	if (byId) return byId;

	const index = new Map<string, SessionEntry>();

	for (const entry of entries) {
		index.set(entry.id, entry);
	}

	return index;
}

// Cycle guard
export function walkBranch(
	byId: Map<string, SessionEntry>,
	startId?: string | null,
): SessionEntry[] {
	const path: SessionEntry[] = [];
	const visited = new Set<string>();
	let current = startId ? byId.get(startId) : undefined;

	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}

	path.reverse();
	return path;
}

export function isValidReplacement(replacement: ContextEditEntry["replacement"]): boolean {
	if (replacement === null) return true;
	if (typeof replacement !== "object") return false;
	if (!("content" in replacement)) return false;

	return typeof replacement.content === "string" || Array.isArray(replacement.content);
}

export function isEditableEntry(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") return true;
	if (entry.type !== "message") return false;

	const { role } = entry.message;

	return role === "user" || role === "assistant" || role === "toolResult";
}

// Retarget entry
export function retargetEntry(
	entry: SessionEntry,
	parentId: string | null,
	replacementByLabelId: Map<string, string>,
): SessionEntry {
	if (entry.type !== "compaction") return { ...entry, parentId };

	const firstKeptEntryId =
		entry.firstKeptEntryId === entry.id
			? entry.id
			: (replacementByLabelId.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId);

	return { ...entry, parentId, firstKeptEntryId };
}

export function createLabelEntries(
	labels: Array<{ targetId: string; label: string; timestamp: string }>,
	parentId: string | null,
	knownIds: Set<string>,
): LabelEntry[] {
	const entries: LabelEntry[] = [];
	let parent = parentId;

	for (const { targetId, label, timestamp } of labels) {
		const entry: LabelEntry = {
			type: "label",
			id: generateId(knownIds),
			parentId: parent,
			timestamp,
			targetId,
			label,
		};

		knownIds.add(entry.id);
		entries.push(entry);
		parent = entry.id;
	}

	return entries;
}

export function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);

	if (leafId === null) return [];

	const requestedLeaf = leafId ? index.get(leafId) : undefined;
	const leaf = requestedLeaf ?? entries[entries.length - 1];

	if (!leaf) return [];

	return walkBranch(index, leaf.id);
}

export function buildSessionTree(
	entries: SessionEntry[],
	labelsById: Map<string, string>,
	labelTimestampsById: Map<string, string>,
): SessionTreeNode[] {
	const nodeMap = new Map<string, SessionTreeNode>();
	const roots: SessionTreeNode[] = [];

	for (const entry of entries) {
		const label = labelsById.get(entry.id);
		const labelTimestamp = labelTimestampsById.get(entry.id);
		nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
	}

	for (const entry of entries) {
		const node = nodeMap.get(entry.id)!;

		if (entry.parentId === null || entry.parentId === entry.id) {
			roots.push(node);
		} else {
			const parent = nodeMap.get(entry.parentId);

			if (parent) {
				parent.children.push(node);
			} else {
				roots.push(node);
			}
		}
	}

	const stack: SessionTreeNode[] = [...roots];

	while (stack.length > 0) {
		const node = stack.pop()!;

		node.children.sort(
			(a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime(),
		);
		stack.push(...node.children);
	}

	return roots;
}
