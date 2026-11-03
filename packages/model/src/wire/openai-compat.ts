interface CompatHostRule {
	providers: readonly string[];
	hosts: readonly string[];
	foldCase?: boolean;
}

const compatHosts = {
	zai: { providers: ["zai", "zai-coding-cn"], hosts: ["api.z.ai", "open.bigmodel.cn"] },
	together: {
		providers: ["together"],
		hosts: ["api.together.ai", "api.together.xyz"],
	},
	moonshot: { providers: ["moonshotai", "moonshotai-cn"], hosts: ["api.moonshot."] },
	openrouter: { providers: ["openrouter"], hosts: ["openrouter.ai"] },
	cloudflareWorkersAI: {
		providers: ["cloudflare-workers-ai"],
		hosts: ["api.cloudflare.com"],
	},
	cloudflareGateway: {
		providers: ["cloudflare-ai-gateway"],
		hosts: ["gateway.ai.cloudflare.com"],
	},
	nvidia: { providers: ["nvidia"], hosts: ["integrate.api.nvidia.com"] },
	antLing: { providers: ["ant-ling"], hosts: ["api.ant-ling.com"] },
	cerebras: { providers: ["cerebras"], hosts: ["cerebras.ai"] },
	deepseek: { providers: ["deepseek"], hosts: ["deepseek.com"], foldCase: true },
	xai: { providers: ["xai"], hosts: ["api.x.ai"] },
	opencode: { providers: ["opencode"], hosts: ["opencode.ai"] },
	chutes: { providers: [], hosts: ["chutes.ai"] },
} satisfies Record<string, CompatHostRule>;

export type CompatHost = keyof typeof compatHosts;

export function matchesHost(host: CompatHost, provider: string, baseUrl: string): boolean {
	const rule: CompatHostRule = compatHosts[host];
	if (rule.providers.includes(provider)) return true;

	const url = rule.foldCase ? baseUrl.toLowerCase() : baseUrl;
	return rule.hosts.some((part) => url.includes(part));
}
