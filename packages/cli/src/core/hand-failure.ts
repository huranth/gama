export const HAND_START_NEXT =
	'Retry action "start" with the same typed hands. If it fails again, start fewer hands at once.';

export const HAND_RUN_NEXT =
	'Use action "talk" to ask for the missing fact, or start a new hand with a narrower input.';

function compact(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

export function formatHandFailure(
	reason: string | undefined,
	next: string = HAND_RUN_NEXT,
): string {
	return `Reason: ${compact(reason) || "Unknown error"}\nNext: ${next}`;
}

export function formatHandFailureBody(
	text: string | undefined,
	next: string = HAND_RUN_NEXT,
): string {
	const clean = (text ?? "").replace(/\r\n?/g, "\n").trim();
	const reason = clean.match(/(?:^|\n)Reason:\s*([^\n]+)/i)?.[1];
	const nextLine = clean.match(/(?:^|\n)Next:\s*([^\n]+)/i)?.[1];

	return formatHandFailure(reason ?? clean, nextLine?.trim() || next);
}

export function handFailureNext(action: string | undefined): string {
	if (action === "start") return HAND_START_NEXT;
	if (action === "wait" || action === "read" || action === "talk") return HAND_RUN_NEXT;
	return "Retry the action with valid parameters.";
}
