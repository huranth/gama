import type { BuildSystemPromptOptions, ExtensionAPI } from "@huranth/gama-harness";

function buildToolGuidance(options: BuildSystemPromptOptions): string {
	const hasTool = (name: string) => options.selectedTools?.includes(name) ?? false;
	const rules: string[] = [];

	if (hasTool("read")) {
		rules.push(
			"- Use `read` for file contents; it supports text and images.",
			"- For large files, use `offset` and `limit` to read in chunks.",
		);
	}
	if (hasTool("bash")) {
		rules.push("- Use `bash` for file operations such as `ls`, `find`, and `grep`.");
	}
	if (hasTool("edit")) {
		rules.push("- Use `edit` for precise text replacements that match existing content exactly.");
	}
	if (hasTool("write")) {
		rules.push("- Use `write` to create new files or replace existing files completely.");
	}
	if (options.skills && options.skills.length > 0) {
		rules.push(`- Available skills: ${options.skills.map((skill) => skill.name).join(", ")}.`);
	}

	return rules.join("\n");
}

export default function promptCustomizer(gama: ExtensionAPI) {
	gama.on("before_agent_start", (event) => {
		const guidance = buildToolGuidance(event.systemPromptOptions);
		if (guidance) {
			event.systemPromptOptions.sections.tool_guidance = guidance;
		} else {
			delete event.systemPromptOptions.sections.tool_guidance;
		}
	});
}
