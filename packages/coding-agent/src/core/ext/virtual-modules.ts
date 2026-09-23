import * as bundledGamaAgentCore from "@huranth/gama-agent-core";
import * as bundledGamaAiCompat from "@huranth/gama-ai/compat";
import * as bundledGamaAiProviders from "@huranth/gama-ai/providers/all";
import * as bundledGamaTui from "@huranth/gama-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import * as bundledGamaCodingAgent from "../../index.ts";

export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@huranth/gama-agent-core": bundledGamaAgentCore,
	"@huranth/gama-tui": bundledGamaTui,
	"@huranth/gama-ai": bundledGamaAiCompat,
	"@huranth/gama-ai/compat": bundledGamaAiCompat,
	"@huranth/gama-ai/providers/all": bundledGamaAiProviders,
	"@huranth/gama-harness": bundledGamaCodingAgent,
};
