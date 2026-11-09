import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/vault.ts";
import { PluginHost } from "../src/core/ext/runner.ts";
import { DefaultResourceLoader, loadProjectContextFiles } from "../src/core/resource-loader.ts";
import { SessionStore } from "../src/core/sessions.ts";
import { SettingsStore } from "../src/core/settings.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/origin.ts";

import { createModelRegistry } from "./model-run-test-utils.ts";
import { DIRECTORY_LINK_TYPE } from "./symlink-support.ts";

describe("DefaultResourceLoader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("reload", () => {
		it("starts empty before reload", () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			expect(loader.getExtensions().extensions).toEqual([]);
			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.getPrompts().prompts).toEqual([]);
			expect(loader.getThemes().themes).toEqual([]);
		});

		it("ignores a project manifest when owning extensions", async () => {
			const extensionsDir = join(cwd, ".gama", "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(
				join(cwd, "package.json"),
				JSON.stringify({ dependencies: { "@huranth/gama-harness": "1.0.0" } }),
			);
			writeFileSync(join(extensionsDir, "project-extension.ts"), "export default function() {}");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getExtensions().extensions).toHaveLength(1);
			expect(loader.getExtensions().warnings).toEqual([]);
		});

		it("warns about host dependencies in a package manifest", async () => {
			const packageRoot = join(tempDir, "extension-package");
			const extensionsDir = join(packageRoot, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(
				join(packageRoot, "package.json"),
				JSON.stringify({ dependencies: { "@huranth/gama-harness": "1.0.0" } }),
			);
			writeFileSync(join(extensionsDir, "package-extension.ts"), "export default function() {}");

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsStore.inMemory({ packages: [packageRoot] }),
			});
			await loader.reload();

			expect(loader.getExtensions().extensions).toHaveLength(1);
			expect(loader.getExtensions().warnings).toEqual([
				{
					path: join(packageRoot, "package.json"),
					warning:
						'Host-provided extension packages must be declared in peerDependencies with a "*" range, no' +
							't dependencies: @huranth/gama-harness. Installed copies can bypass the extension loader a' +
							'nd create duplicate runtime modules.',
				},
			]);
		});

		it("fails on an unparsable package manifest", async () => {
			const packageRoot = join(tempDir, "invalid-extension-package");
			const extensionsDir = join(packageRoot, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(packageRoot, "package.json"), "{");
			writeFileSync(join(extensionsDir, "package-extension.ts"), "export default function() {}");

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsStore.inMemory({ packages: [packageRoot] }),
			});

			await expect(loader.reload()).rejects.toThrow(SyntaxError);
		});

		it("discovers skills from agentDir", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Skill content here.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "test-skill")).toBe(true);
		});

		it("ignores extra markdown in skill dirs", async () => {
			const skillDir = join(agentDir, "skills", "gama-skills", "browser-tools");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: browser-tools
description: Browser tools
---
Skill content here.`,
			);
			writeFileSync(join(skillDir, "EFFICIENCY.md"), "No frontmatter here");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			expect(skills.some((s) => s.name === "browser-tools")).toBe(true);
			expect(diagnostics.some((d) => d.path?.endsWith("EFFICIENCY.md"))).toBe(false);
		});

		it("discovers prompts from agentDir", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(
				join(promptsDir, "test-prompt.md"),
				`---
description: A test prompt
---
Prompt content.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { prompts } = loader.getPrompts();
			expect(prompts.some((p) => p.name === "test-prompt")).toBe(true);
		});

		it("reports invalid frontmatter, loads valid prompts", async () => {
			const promptsDir = join(agentDir, "prompts");
			const invalidPromptPath = join(promptsDir, "invalid.md");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(
				invalidPromptPath,
				"---\ndescription: Broken: unquoted colon\n---\nDo something.\n",
			);
			writeFileSync(join(promptsDir, "valid.md"), "Valid prompt content.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { prompts, diagnostics } = loader.getPrompts();
			expect(prompts.map((prompt) => prompt.name)).toEqual(["valid"]);
			expect(diagnostics).toEqual([
				expect.objectContaining({
					type: "warning",
					path: invalidPromptPath,
					message: expect.stringContaining("line 1, column 14"),
				}),
			]);
		});

		it("prefers project resources on collisions", async () => {
			const userPromptsDir = join(agentDir, "prompts");
			const projectPromptsDir = join(cwd, ".gama", "prompts");
			mkdirSync(userPromptsDir, { recursive: true });
			mkdirSync(projectPromptsDir, { recursive: true });
			const userPromptPath = join(userPromptsDir, "commit.md");
			const projectPromptPath = join(projectPromptsDir, "commit.md");
			writeFileSync(userPromptPath, "User prompt");
			writeFileSync(projectPromptPath, "Project prompt");

			const userSkillDir = join(agentDir, "skills", "collision-skill");
			const projectSkillDir = join(cwd, ".gama", "skills", "collision-skill");
			mkdirSync(userSkillDir, { recursive: true });
			mkdirSync(projectSkillDir, { recursive: true });
			const userSkillPath = join(userSkillDir, "SKILL.md");
			const projectSkillPath = join(projectSkillDir, "SKILL.md");
			writeFileSync(
				userSkillPath,
				`---
name: collision-skill
description: user
---
User skill`,
			);
			writeFileSync(
				projectSkillPath,
				`---
name: collision-skill
description: project
---
Project skill`,
			);

			const baseTheme = JSON.parse(
				readFileSync(join(process.cwd(), "src", "term", "theme", "dark.json"), "utf-8"),
			) as { name: string; vars?: Record<string, string> };
			baseTheme.name = "collision-theme";
			const userThemePath = join(agentDir, "themes", "collision.json");
			const projectThemePath = join(cwd, ".gama", "themes", "collision.json");
			mkdirSync(join(agentDir, "themes"), { recursive: true });
			mkdirSync(join(cwd, ".gama", "themes"), { recursive: true });
			writeFileSync(userThemePath, JSON.stringify(baseTheme, null, 2));
			if (baseTheme.vars) {
				baseTheme.vars.accent = "#ff00ff";
			}
			writeFileSync(projectThemePath, JSON.stringify(baseTheme, null, 2));

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const prompt = loader.getPrompts().prompts.find((p) => p.name === "commit");
			expect(prompt?.filePath).toBe(projectPromptPath);

			const skill = loader.getSkills().skills.find((s) => s.name === "collision-skill");
			expect(skill?.filePath).toBe(projectSkillPath);

			const theme = loader.getThemes().themes.find((t) => t.name === "collision-theme");
			expect(theme?.sourcePath).toBe(projectThemePath);
		});

		it("loads symlinked extensions once", async () => {
			const sharedExtDir = join(tempDir, "shared-extensions");
			mkdirSync(sharedExtDir, { recursive: true });
			writeFileSync(
				join(sharedExtDir, "shared.ts"),
				`export default function(gama) {
	gama.registerCommand("shared", {
		description: "shared command",
		handler: async () => {},
	});
}`,
			);

			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(cwd, ".gama"), { recursive: true });
			symlinkSync(sharedExtDir, join(agentDir, "extensions"), DIRECTORY_LINK_TYPE);
			symlinkSync(sharedExtDir, join(cwd, ".gama", "extensions"), DIRECTORY_LINK_TYPE);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(1);
			expect(extensionsResult.errors).toEqual([]);

			expect(extensionsResult.extensions[0].path).toBe(
				join(cwd, ".gama", "extensions", "shared.ts"),
			);
		});

		it("loads user extensions before trust, reuses them", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(cwd, ".gama", "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });
			const loadCountKey =
				`__piTrustPreloadCount_${Date.now()}_` + `${Math.random().toString(36).slice(2)}`;
			const globalState = globalThis as typeof globalThis & Record<string, number | undefined>;

			writeFileSync(
				join(userExtDir, "user.ts"),
				`globalThis[${JSON.stringify(loadCountKey)}] = (globalThis[${JSON.stringify(loadCountKey)}] ?` +
					`? 0) + 1;
export default function(gama) {
	gama.on("project_trust", () => ({ trusted: "yes" }));
	gama.registerCommand("user-trust", {
		description: "user trust",
		handler: async () => {},
	});
}`,
			);
			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(gama) {
	gama.registerCommand("project-trusted", {
		description: "project trusted",
		handler: async () => {},
	});
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload({
				resolveProjectTrust: async ({ extensionsResult }) => {
					expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([
						join(userExtDir, "user.ts"),
					]);
					return true;
				},
			});

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([
				join(cwd, ".gama", "extensions", "project.ts"),
				join(userExtDir, "user.ts"),
			]);
			expect(globalState[loadCountKey]).toBe(1);
		});

		it("keeps both extensions on command collisions", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(cwd, ".gama", "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });

			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(gama) {
	gama.registerCommand("deploy", {
		description: "project deploy",
		handler: async () => {},
	});
	gama.registerCommand("project-only", {
		description: "project only",
		handler: async () => {},
	});
}`,
			);

			writeFileSync(
				join(userExtDir, "user.ts"),
				`export default function(gama) {
	gama.registerCommand("deploy", {
		description: "user deploy",
		handler: async () => {},
	});
	gama.registerCommand("user-only", {
		description: "user only",
		handler: async () => {},
	});
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(2);
			expect(
				extensionsResult.errors.some((e) => e.error.includes('Command "/deploy" conflicts')),
			).toBe(false);

			const sessionManager = SessionStore.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = await createModelRegistry(authStorage);
			const runner = new PluginHost(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("project deploy");
			expect(runner.getCommand("deploy:2")?.description).toBe("user deploy");
			expect(runner.getCommand("project-only")?.description).toBe("project only");
			expect(runner.getCommand("user-only")?.description).toBe("user only");

			const commands = runner.getRegisteredCommands();
			expect(commands.map((command) => command.invocationName)).toEqual([
				"deploy:1",
				"project-only",
				"deploy:2",
				"user-only",
			]);
		});

		it("honors overrides for discovered resources", async () => {
			const settingsManager = SettingsStore.inMemory();
			settingsManager.setExtensionPaths(["-extensions/disabled.ts"]);
			settingsManager.setSkillPaths(["-skills/skip-skill"]);
			settingsManager.setPromptTemplatePaths(["-prompts/skip.md"]);
			settingsManager.setThemePaths(["-themes/skip.json"]);

			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "disabled.ts"), "export default function() {}");

			const skillDir = join(agentDir, "skills", "skip-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: skip-skill
description: Skip me
---
Content`,
			);

			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "skip.md"), "Skip prompt");

			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "skip.json"), "{}");

			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			const { extensions } = loader.getExtensions();
			const { skills } = loader.getSkills();
			const { prompts } = loader.getPrompts();
			const { themes } = loader.getThemes();

			expect(extensions.some((e) => e.path.endsWith("disabled.ts"))).toBe(false);
			expect(skills.some((s) => s.name === "skip-skill")).toBe(false);
			expect(prompts.some((p) => p.name === "skip")).toBe(false);
			expect(themes.some((t) => t.sourcePath?.endsWith("skip.json"))).toBe(false);
		});

		it("discovers AGENTS.md context files", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles.some((f) => f.path.includes("AGENTS.md"))).toBe(true);
		});

		it("prefers AGENTS.override.md per directory", async () => {
				const nestedCwd = join(cwd, "service");
				mkdirSync(nestedCwd);
				writeFileSync(join(agentDir, "AGENTS.md"), "global instructions");
				writeFileSync(join(agentDir, "AGENTS.override.md"), "global override");
				writeFileSync(join(cwd, "AGENTS.md"), "project instructions");
				writeFileSync(join(nestedCwd, "AGENTS.md"), "service instructions");
				writeFileSync(join(nestedCwd, "AGENTS.override.md"), "service override");

				const loader = new DefaultResourceLoader({ cwd: nestedCwd, agentDir });
				await loader.reload();

				expect(loader.getAgentsFiles().agentsFiles).toEqual([
					{ path: join(agentDir, "AGENTS.override.md"), content: "global override" },
					{ path: join(cwd, "AGENTS.md"), content: "project instructions" },
					{ path: join(nestedCwd, "AGENTS.override.md"), content: "service override" },
				]);
			},
		);

		it("ignores context paths that are directories", async () => {
			mkdirSync(join(cwd, "AGENTS.override.md"));
			mkdirSync(join(cwd, "AGENTS.md"));
			writeFileSync(join(cwd, "CLAUDE.md"), "Fallback instructions");
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAgentsFiles().agentsFiles).toContainEqual({
				path: join(cwd, "CLAUDE.md"),
				content: "Fallback instructions",
			});
			expect(consoleError).not.toHaveBeenCalledWith(
				expect.stringContaining(join(cwd, "AGENTS.md")),
			);
			expect(consoleError).not.toHaveBeenCalledWith(
				expect.stringContaining(join(cwd, "AGENTS.override.md")),
			);
			consoleError.mockRestore();
		});

		it("skips context discovery with noContextFiles", async () => {
			writeFileSync(join(cwd, "AGENTS.override.md"), "# Override Guidelines\n\nBe helpful.");
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");
			writeFileSync(join(cwd, "CLAUDE.md"), "# Claude Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles).toEqual([]);
		});

		it("discovers SYSTEM.md from cwd/.gama", async () => {
			const gamaDir = join(cwd, ".gama");
			mkdirSync(gamaDir, { recursive: true });
			writeFileSync(join(gamaDir, "SYSTEM.md"), "You are a helpful assistant.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("You are a helpful assistant.");
		});

		it("skips project resources when untrusted", async () => {
			const gamaDir = join(cwd, ".gama");
			const extensionsDir = join(gamaDir, "extensions");
			const skillDir = join(gamaDir, "skills", "project-skill");
			const promptsDir = join(gamaDir, "prompts");
			const themesDir = join(gamaDir, "themes");
			mkdirSync(extensionsDir, { recursive: true });
			mkdirSync(skillDir, { recursive: true });
			mkdirSync(promptsDir, { recursive: true });
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(gamaDir, "SYSTEM.md"), "Project system prompt.");
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");
			writeFileSync(join(agentDir, "AGENTS.md"), "Global instructions");
			writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
			writeFileSync(join(extensionsDir, "project.ts"), `throw new Error("should not load");`);
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: project-skill
description: Project skill
---
Project skill content`,
			);
			writeFileSync(join(promptsDir, "project.md"), "Project prompt");
			const themeData = JSON.parse(
				readFileSync(join(process.cwd(), "src", "term", "theme", "dark.json"), "utf-8"),
			) as { name: string };
			themeData.name = "project-theme";
			writeFileSync(join(themesDir, "project.json"), JSON.stringify(themeData, null, 2));
			const settingsManager = SettingsStore.create(cwd, agentDir, {
				projectTrusted: false,
			});

			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Global system prompt.");
			expect(
				loader
					.getAgentsFiles()
					.agentsFiles.some((file) => file.path === join(agentDir, "AGENTS.md")),
			).toBe(true);
			expect(
				loader
					.getAgentsFiles()
					.agentsFiles.some((file) => file.path === join(cwd, "AGENTS.md")),
			).toBe(true);
			expect(loader.getExtensions().extensions).toHaveLength(0);
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getSkills().skills.some((skill) => skill.name === "project-skill")).toBe(
				false,
			);
			expect(loader.getPrompts().prompts.some((prompt) => prompt.name === "project")).toBe(
				false,
			);
			expect(loader.getThemes().themes.some((theme) => theme.name === "project-theme")).toBe(
				false,
			);
		});

		it("discovers APPEND_SYSTEM.md", async () => {
			const gamaDir = join(cwd, ".gama");
			mkdirSync(gamaDir, { recursive: true });
			writeFileSync(join(gamaDir, "APPEND_SYSTEM.md"), "Additional instructions.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toContain("Additional instructions.");
		});
	});

	describe("system prompt sources", () => {
		it("exposes discovered project SYSTEM.md as the system prompt source", async () => {
			const gamaDir = join(cwd, ".gama");
			const systemPromptPath = join(gamaDir, "SYSTEM.md");
			mkdirSync(gamaDir, { recursive: true });
			writeFileSync(systemPromptPath, "Project system prompt.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Project system prompt.");
			expect(loader.getSystemPromptSource()).toEqual({ path: systemPromptPath });
		});

		it("exposes discovered global SYSTEM.md as the system prompt source", async () => {
			const systemPromptPath = join(agentDir, "SYSTEM.md");
			writeFileSync(systemPromptPath, "Global system prompt.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Global system prompt.");
			expect(loader.getSystemPromptSource()).toEqual({ path: systemPromptPath });
		});

		it("does not expose literal system prompt text as a source", async () => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				systemPrompt: "Literal system prompt.",
			});
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Literal system prompt.");
			expect(loader.getSystemPromptSource()).toBeUndefined();
		});

		it("exposes file-backed system prompt options as a source", async () => {
			const systemPromptPath = join(tempDir, "custom-system.md");
			writeFileSync(systemPromptPath, "Custom system prompt.");

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				systemPrompt: systemPromptPath,
			});
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Custom system prompt.");
			expect(loader.getSystemPromptSource()).toEqual({ path: systemPromptPath });
		});

		it("exposes discovered APPEND_SYSTEM.md as an append system prompt source", async () => {
			const gamaDir = join(cwd, ".gama");
			const appendSystemPromptPath = join(gamaDir, "APPEND_SYSTEM.md");
			mkdirSync(gamaDir, { recursive: true });
			writeFileSync(appendSystemPromptPath, "Project append prompt.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toEqual(["Project append prompt."]);
			expect(loader.getAppendSystemPromptSources()).toEqual([{ path: appendSystemPromptPath }]);
		});

		it("does not expose literal append system prompt text as a source", async () => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				appendSystemPrompt: ["Literal append prompt."],
			});
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toEqual(["Literal append prompt."]);
			expect(loader.getAppendSystemPromptSources()).toEqual([]);
		});

		it("only exposes file-backed append system prompt options as sources", async () => {
			const appendSystemPromptPath = join(tempDir, "custom-append.md");
			writeFileSync(appendSystemPromptPath, "Custom append prompt.");

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				appendSystemPrompt: [appendSystemPromptPath, "Literal append prompt."],
			});
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toEqual([
				"Custom append prompt.",
				"Literal append prompt.",
			]);
			expect(loader.getAppendSystemPromptSources()).toEqual([{ path: appendSystemPromptPath }]);
		});
	});

	describe("extendResources", () => {
		it("loads skills and prompts with metadata", async () => {
			const extraSkillDir = join(tempDir, "extra-skills", "extra-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: extra-skill
description: Extra skill
---
Extra content`,
			);

			const extraPromptDir = join(tempDir, "extra-prompts");
			mkdirSync(extraPromptDir, { recursive: true });
			const promptPath = join(extraPromptDir, "extra.md");
			writeFileSync(
				promptPath,
				`---
description: Extra prompt
---
Extra prompt content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: extraSkillDir,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
				promptPaths: [
					{
						path: promptPath,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraPromptDir,
						},
					},
				],
			});

			const { skills } = loader.getSkills();
			const loadedSkill = skills.find((skill) => skill.name === "extra-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedSkill?.sourceInfo?.path).toBe(skillPath);

			const { prompts } = loader.getPrompts();
			const loadedPrompt = prompts.find((prompt) => prompt.name === "extra");
			expect(loadedPrompt).toBeDefined();
			expect(loadedPrompt?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedPrompt?.sourceInfo?.path).toBe(promptPath);
		});

		it("loads extension resources from file URLs", async () => {
			const extraSkillDir = join(tempDir, "extra skills", "file-url-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: file-url-skill
description: File URL skill
---
Extra content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: pathToFileURL(extraSkillDir).href,
						metadata: {
							source: "extension:file-url",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
			});

			const { skills, diagnostics } = loader.getSkills();
			expect(diagnostics).toEqual([]);
			const loadedSkill = skills.find((skill) => skill.name === "file-url-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.filePath).toBe(skillPath);
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:file-url");
		});

		it("keeps package metadata for resources", async () => {
			const packageRoot = join(agentDir, "npm", "node_modules", "metadata-pkg");
			const packageSkillDir = join(packageRoot, "skills", "package-skill");
			const packagePromptsDir = join(packageRoot, "prompts");
			const packageThemesDir = join(packageRoot, "themes");
			mkdirSync(packageSkillDir, { recursive: true });
			mkdirSync(packagePromptsDir, { recursive: true });
			mkdirSync(packageThemesDir, { recursive: true });
			writeFileSync(
				join(packageRoot, "package.json"),
				JSON.stringify({ name: "metadata-pkg", version: "1.0.0" }),
			);
			writeFileSync(
				join(packageSkillDir, "SKILL.md"),
				`---
name: package-skill
description: Package skill
---
Package skill content`,
			);
			writeFileSync(
				join(packagePromptsDir, "package-prompt.md"),
				`---
description: Package prompt
---
Package prompt content`,
			);
			const baseTheme = JSON.parse(
				readFileSync(join(process.cwd(), "src", "term", "theme", "dark.json"), "utf-8"),
			) as { name: string };
			writeFileSync(
				join(packageThemesDir, "package-theme.json"),
				JSON.stringify({ ...baseTheme, name: "package-theme" }),
			);

			const extensionResourceDir = join(tempDir, "extension-resources");
			const extensionSkillDir = join(extensionResourceDir, "extension-skill");
			const extensionPromptsDir = join(extensionResourceDir, "prompts");
			const extensionThemesDir = join(extensionResourceDir, "themes");
			mkdirSync(extensionSkillDir, { recursive: true });
			mkdirSync(extensionPromptsDir, { recursive: true });
			mkdirSync(extensionThemesDir, { recursive: true });
			writeFileSync(
				join(extensionSkillDir, "SKILL.md"),
				`---
name: extension-skill
description: Extension skill
---
Extension skill content`,
			);
			writeFileSync(
				join(extensionPromptsDir, "extension-prompt.md"),
				`---
description: Extension prompt
---
Extension prompt content`,
			);
			writeFileSync(
				join(extensionThemesDir, "extension.json"),
				JSON.stringify({ ...baseTheme, name: "extension-theme" }),
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsStore.inMemory({ packages: ["npm:metadata-pkg"] }),
			});
			await loader.reload();

			const extensionMetadata = {
				source: "extension:discovery",
				scope: "temporary",
				origin: "top-level",
			} as const;
			loader.extendResources({
				skillPaths: [{ path: extensionSkillDir, metadata: extensionMetadata }],
				promptPaths: [{ path: extensionPromptsDir, metadata: extensionMetadata }],
				themePaths: [{ path: extensionThemesDir, metadata: extensionMetadata }],
			});

			const packageSourceInfo = { source: "npm:metadata-pkg", scope: "user", origin: "package" };
			expect(
				loader.getSkills().skills.find((skill) => skill.name === "package-skill")?.sourceInfo,
			).toMatchObject(packageSourceInfo);
			expect(
				loader.getPrompts().prompts.find((prompt) => prompt.name === "package-prompt")
					?.sourceInfo,
			).toMatchObject(packageSourceInfo);
			expect(
				loader.getThemes().themes.find((theme) => theme.name === "package-theme")?.sourceInfo,
			).toMatchObject(packageSourceInfo);

			expect(
				loader.getSkills().skills.find((skill) => skill.name === "extension-skill")?.sourceInfo,
			).toMatchObject(extensionMetadata);
			expect(
				loader.getPrompts().prompts.find((prompt) => prompt.name === "extension-prompt")
					?.sourceInfo,
			).toMatchObject(extensionMetadata);
			expect(
				loader.getThemes().themes.find((theme) => theme.name === "extension-theme")?.sourceInfo,
			).toMatchObject(extensionMetadata);
		});
	});

	describe("noSkills option", () => {
		it("skips skill discovery with noSkills", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toEqual([]);
		});

		it("still loads extra skill paths with noSkills", async () => {
			const customSkillDir = join(tempDir, "custom-skills");
			mkdirSync(customSkillDir, { recursive: true });
			writeFileSync(
				join(customSkillDir, "custom.md"),
				`---
name: custom
description: Custom skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noSkills: true,
				additionalSkillPaths: [customSkillDir],
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "custom")).toBe(true);
		});
	});

	describe("override functions", () => {
		it("applies skillsOverride", async () => {
			const injectedSkill: Skill = {
				name: "injected",
				description: "Injected skill",
				filePath: "/fake/path",
				baseDir: "/fake",
				sourceInfo: createSyntheticSourceInfo("/fake/path", { source: "custom" }),
				disableModelInvocation: false,
			};
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				skillsOverride: () => ({
					skills: [injectedSkill],
					diagnostics: [],
				}),
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("injected");
		});

		it("applies systemPromptOverride", async () => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				systemPromptOverride: () => "Custom system prompt",
			});
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Custom system prompt");
		});
	});

	describe("extension conflict detection", () => {
		it("detects tool conflicts between extensions", async () => {
			const ext1Dir = join(agentDir, "extensions", "ext1");
			const ext2Dir = join(agentDir, "extensions", "ext2");
			mkdirSync(ext1Dir, { recursive: true });
			mkdirSync(ext2Dir, { recursive: true });

			writeFileSync(
				join(ext1Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@huranth/gama-harness";
import { Type } from "typebox";
export default function(gama: ExtensionAPI) {
  gama.registerTool({
    name: "duplicate-tool",
    description: "First",
    parameters: Type.Object({}),
    execute: async () => ({ result: "1" }),
  });
}`,
			);

			writeFileSync(
				join(ext2Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@huranth/gama-harness";
import { Type } from "typebox";
export default function(gama: ExtensionAPI) {
  gama.registerTool({
    name: "duplicate-tool",
    description: "Second",
    parameters: Type.Object({}),
    execute: async () => ({ result: "2" }),
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { errors } = loader.getExtensions();
			expect(
				errors.some((e) => e.error.includes("duplicate-tool") && e.error.includes("conflicts")),
			).toBe(true);
		});

		it("prefers explicit CLI extensions on conflicts", async () => {
				const globalExtDir = join(agentDir, "extensions");
				mkdirSync(globalExtDir, { recursive: true });
				const explicitExtPath = join(tempDir, "explicit-extension.ts");

				writeFileSync(
					join(globalExtDir, "global.ts"),
					`
import type { ExtensionAPI } from "@huranth/gama-harness";
import { Type } from "typebox";
export default function(gama: ExtensionAPI) {
  gama.registerTool({
    name: "duplicate-tool",
    description: "global tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "global" }),
  });
  gama.registerCommand("deploy", {
    description: "global command",
    handler: async () => {},
  });
}`,
				);

				writeFileSync(
					explicitExtPath,
					`
import type { ExtensionAPI } from "@huranth/gama-harness";
import { Type } from "typebox";
export default function(gama: ExtensionAPI) {
  gama.registerTool({
    name: "duplicate-tool",
    description: "explicit tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "explicit" }),
  });
  gama.registerCommand("deploy", {
    description: "explicit command",
    handler: async () => {},
  });
}`,
				);

				const loader = new DefaultResourceLoader({
					cwd,
					agentDir,
					additionalExtensionPaths: [explicitExtPath],
				});
				await loader.reload();

				const extensionsResult = loader.getExtensions();
				expect(extensionsResult.extensions[0]?.path).toBe(explicitExtPath);

				const sessionManager = SessionStore.inMemory();
				const authStorage = AuthStorage.create(join(tempDir, "auth-explicit.json"));
				const modelRegistry = await createModelRegistry(authStorage);
				const runner = new PluginHost(
					extensionsResult.extensions,
					extensionsResult.runtime,
					cwd,
					sessionManager,
					modelRegistry,
				);

				expect(runner.getCommand("deploy:1")?.description).toBe("explicit command");
				expect(runner.getCommand("deploy:2")?.description).toBe("global command");
				expect(runner.getToolDefinition("duplicate-tool")?.description).toBe("explicit tool");
			},
		);

		it("leaves out replaced extensions", async () => {
			const globalExtDir = join(agentDir, "extensions");
			mkdirSync(globalExtDir, { recursive: true });
			writeFileSync(
				join(globalExtDir, "other-mcp.ts"),
				`
import type { ExtensionAPI } from "@huranth/gama-harness";
export default function(gama: ExtensionAPI) {
  gama.registerCommand("mcp", { description: "other mcp", handler: async () => {} });
}`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				extensionFactories: [
					{
						name: "mcp",
						replaceable: true,
						factory: (gama) =>
							gama.registerCommand("mcp", {
								description: "built-in mcp",
								handler: async () => {},
							}),
					},
					{
						name: "llama",
						replaceable: true,
						factory: (gama) =>
							gama.registerCommand("llama", {
								description: "built-in llama",
								handler: async () => {},
							}),
					},
				],
			});
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([
				join(globalExtDir, "other-mcp.ts"),
				"<inline:llama>",
			]);
			expect(extensionsResult.errors).toEqual([]);

			const runner = new PluginHost(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				SessionStore.inMemory(),
				await createModelRegistry(AuthStorage.create(join(tempDir, "auth-replaceable.json"))),
			);
			expect(runner.getCommand("mcp")?.description).toBe("other mcp");
			expect(runner.getCommand("llama")?.description).toBe("built-in llama");
		});

		it("skips built-ins disabled in settings", async () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ extensions: ["-builtin:mcp"] }),
			);
			const loaded: string[] = [];
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				extensionFactories: [
					{ name: "mcp", builtin: true, factory: () => void loaded.push("mcp") },
					{ name: "llama", builtin: true, factory: () => void loaded.push("llama") },
				],
			});
			await loader.reload();

			expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
				"builtin:llama",
			]);
			expect(loader.getExtensions().extensions[0].sourceInfo).toMatchObject({
				path: "builtin:llama",
				source: "builtin",
			});
			expect(loader.getExtensions().extensions[0].hidden).toBe(true);
			expect(loaded).toEqual(["llama"]);
		});

		it("loads built-ins after file extensions", async () => {
				const userExtDir = join(agentDir, "extensions");
				mkdirSync(userExtDir, { recursive: true });
				writeFileSync(join(userExtDir, "user.ts"), "export default function() {}");
				mkdirSync(join(cwd, ".gama"), { recursive: true });
				writeFileSync(
					join(cwd, ".gama", "settings.json"),
					JSON.stringify({ extensions: ["+builtin:mcp"] }),
				);
				const loader = new DefaultResourceLoader({
					cwd,
					agentDir,
					extensionFactories: [{ name: "mcp", builtin: true, factory: () => {} }],
				});
				const expected = [join(userExtDir, "user.ts"), "builtin:mcp"];

				await loader.reload({ resolveProjectTrust: async () => true });
				expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual(
					expected,
				);
				await loader.reload();
				expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual(
					expected,
				);
			},
		);

		it("loads built-ins with noExtensions", async () => {
				const loaded: string[] = [];
				const loader = new DefaultResourceLoader({
					cwd,
					agentDir,
					noExtensions: true,
					additionalExtensionPaths: ["builtin:mcp", "builtin:missing"],
					extensionFactories: [
						{ name: "mcp", builtin: true, factory: () => void loaded.push("mcp") },
						{ name: "llama", builtin: true, factory: () => void loaded.push("llama") },
					],
				});
				await loader.reload();

				expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
					"builtin:mcp",
				]);
				expect(loader.getExtensions().errors).toEqual([
					{ path: "builtin:missing", error: "Unknown built-in extension: builtin:missing" },
				]);
				expect(loaded).toEqual(["mcp"]);
			},
		);

		it("applies project built-in overrides after trust", async () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ extensions: ["-builtin:mcp"] }),
			);
			mkdirSync(join(cwd, ".gama"), { recursive: true });
			writeFileSync(
				join(cwd, ".gama", "settings.json"),
				JSON.stringify({ extensions: ["+builtin:mcp", "-builtin:llama"] }),
			);
			const loaded: string[] = [];
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				extensionFactories: [
					{ name: "mcp", builtin: true, factory: () => void loaded.push("mcp") },
					{ name: "plain", factory: () => void loaded.push("plain") },
					{ name: "llama", builtin: true, factory: () => void loaded.push("llama") },
				],
			});
			await loader.reload({
				resolveProjectTrust: async ({ extensionsResult }) => {
					expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([
						"<inline:plain>",
					]);
					return true;
				},
			});

			expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
				"builtin:mcp",
				"<inline:plain>",
			]);
			expect(loaded).toEqual(["plain", "mcp"]);
		});
	});

	describe("loadProjectContextFiles - nested worktree dedup", () => {
		const linkWorktree = (mainDir: string, worktreeDir: string, name: string) => {
			const gitDir = join(mainDir, ".git", "worktrees", name);
			mkdirSync(gitDir, { recursive: true });
			writeFileSync(join(mainDir, ".git", "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feat\n");
			writeFileSync(join(gitDir, "commondir"), "../..");
			writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
		};

		const setupNestedWorktree = () => {
			const outer = join(tempDir, "outer");
			const main = join(outer, "main");
			const worktree = join(main, "worktrees", "feat");
			const worktreeSrc = join(worktree, "src");
			mkdirSync(worktreeSrc, { recursive: true });
			linkWorktree(main, worktree, "feat");
			return { outer, main, worktree, worktreeSrc };
		};

		it("skips the main repo duplicate when the worktree has context", () => {
			const { main, worktree, worktreeSrc } = setupNestedWorktree();
			writeFileSync(join(main, "AGENTS.md"), "main repo instructions");
			writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

			const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual(["worktree instructions"]);
		});

		it("inherits main repo context when the worktree has none", () => {
			const { main, worktreeSrc } = setupNestedWorktree();
			writeFileSync(join(main, "AGENTS.md"), "main repo instructions");

			const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual(["main repo instructions"]);
		});

		it("skips only the same filename", () => {
			const { main, worktree, worktreeSrc } = setupNestedWorktree();
			writeFileSync(join(main, "CLAUDE.md"), "main repo instructions");
			writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

			const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual([
				"main repo instructions",
				"worktree instructions",
			]);
		});

		it("keeps the container context in a bare layout", () => {
			const proj = join(tempDir, "proj");
			const bare = join(proj, ".bare");
			const worktree = join(proj, "main");
			const worktreeGitDir = join(bare, "worktrees", "main");
			mkdirSync(worktreeGitDir, { recursive: true });
			mkdirSync(worktree, { recursive: true });
			writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(worktreeGitDir, "commondir"), "../..");
			writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
			writeFileSync(join(proj, "AGENTS.md"), "container instructions");
			writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

			const files = loadProjectContextFiles({ cwd: worktree, agentDir });

			expect(files.map((f) => f.content)).toEqual([
				"container instructions",
				"worktree instructions",
			]);
		});

		it("keeps loading ancestors above the main repo", () => {
			const { outer, main, worktree, worktreeSrc } = setupNestedWorktree();
			writeFileSync(join(outer, "AGENTS.md"), "outer instructions");
			writeFileSync(join(main, "AGENTS.md"), "main repo instructions");
			writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

			const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual([
				"outer instructions",
				"worktree instructions",
			]);
		});

		it("keeps sibling worktree context", () => {
			const outer = join(tempDir, "outer");
			const main = join(outer, "main");
			const sib = join(outer, "sib-feat");
			const sibSrc = join(sib, "src");
			mkdirSync(sibSrc, { recursive: true });
			mkdirSync(main, { recursive: true });
			writeFileSync(join(outer, "AGENTS.md"), "outer instructions");
			writeFileSync(join(sib, "AGENTS.md"), "sibling worktree instructions");
			linkWorktree(main, sib, "sib");

			const files = loadProjectContextFiles({ cwd: sibSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual([
				"outer instructions",
				"sibling worktree instructions",
			]);
		});

		it("keeps the superproject context inside a submodule", () => {
			const sup = join(tempDir, "super");
			const sub = join(sup, "vendor", "lib");
			const subSrc = join(sub, "src");
			mkdirSync(subSrc, { recursive: true });
			writeFileSync(join(sup, "AGENTS.md"), "superproject instructions");
			writeFileSync(join(sub, "AGENTS.md"), "submodule instructions");
			const subGitDir = join(sup, ".git", "modules", "vendor", "lib");
			mkdirSync(subGitDir, { recursive: true });
			writeFileSync(join(subGitDir, "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(sub, ".git"), `gitdir: ${subGitDir}\n`);

			const files = loadProjectContextFiles({ cwd: subSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual([
				"superproject instructions",
				"submodule instructions",
			]);
		});

		it("keeps climbing past an ordinary repo root", () => {
			const outer = join(tempDir, "outer");
			const repo = join(outer, "repo");
			const leaf = join(repo, "src");
			mkdirSync(leaf, { recursive: true });
			mkdirSync(join(repo, ".git"), { recursive: true });
			writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(outer, "AGENTS.md"), "outer instructions");
			writeFileSync(join(repo, "AGENTS.md"), "repo instructions");
			writeFileSync(join(leaf, "AGENTS.md"), "leaf instructions");

			const files = loadProjectContextFiles({ cwd: leaf, agentDir });

			expect(files.map((f) => f.content)).toEqual([
				"outer instructions",
				"repo instructions",
				"leaf instructions",
			]);
		});

		it("climbs when the gitdir target is missing", () => {
			const repo = join(tempDir, "corrupt");
			const src = join(repo, "src");
			mkdirSync(src, { recursive: true });
			writeFileSync(join(repo, ".git"), "gitdir: /nonexistent/path/worktrees/feat\n");
			writeFileSync(join(repo, "AGENTS.md"), "repo instructions");
			writeFileSync(join(src, "AGENTS.md"), "src instructions");

			const files = loadProjectContextFiles({ cwd: src, agentDir });

			expect(files.map((f) => f.content)).toEqual(["repo instructions", "src instructions"]);
		});
	});
});
