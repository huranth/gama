import { bedrockProviderModule } from "@huranth/gama-ai/bedrock-provider";
import { setBedrockProviderModule } from "@huranth/gama-ai/compat";
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { APP_NAME, setEmbeddedQuickJSWasmPath } from "../config.ts";

function muteWarnings(): void {}

process.title = APP_NAME;
process.emitWarning = muteWarnings as typeof process.emitWarning;

setBedrockProviderModule(bedrockProviderModule);
setEmbeddedQuickJSWasmPath(quickjsWasmPath);
