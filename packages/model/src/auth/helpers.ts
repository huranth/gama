import type { ApiKeyAuth } from "./types.ts";

export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		login: async (interaction) => {
			interaction.signal.throwIfAborted();

			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			interaction.signal.throwIfAborted();

			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();

			if (credential?.key) {
				return {
					auth: { apiKey: credential.key },
					env: credential.env,
					source: "stored credential",
				};
			}

			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();

				if (value) return { auth: { apiKey: value }, source: envVar };
			}

			return undefined;
		},
	};
}
