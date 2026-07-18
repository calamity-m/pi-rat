import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Copy parent-session provider overrides and ephemeral auth into an isolated subagent runtime. */
export async function configureSubagentModelRuntime(
  runtime: Pick<ModelRuntime, "registerProvider" | "setRuntimeApiKey">,
  registry: Pick<
    ModelRegistry,
    "getRegisteredProviderConfig" | "getRegisteredProviderIds" | "getApiKeyAndHeaders"
  >,
  model: Model<any>,
): Promise<void> {
  for (const providerId of registry.getRegisteredProviderIds()) {
    const config = registry.getRegisteredProviderConfig(providerId);
    if (config) runtime.registerProvider(providerId, config);
  }

  const auth = await registry.getApiKeyAndHeaders(model);
  if (auth.ok && auth.apiKey) {
    await runtime.setRuntimeApiKey(model.provider, auth.apiKey);
  }
}
