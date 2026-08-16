interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

/**
 * Approximate — verify against your Azure resource's actual pricing page for
 * your region before trusting these numbers for real budgeting; Azure OpenAI
 * pricing can differ slightly from OpenAI's own and changes over time.
 * Unknown deployments return `undefined` rather than a guessed number.
 */
const PRICING_USD_PER_MILLION_TOKENS: Record<string, ModelPricing> = {
  "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  // OpenRouter model ids (verified against openrouter.ai/api/v1/models pricing at the time
  // these defaults were chosen) — re-check if the default models in .env.example ever change.
  "anthropic/claude-sonnet-5": { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  "openai/gpt-5.5-pro": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  // Unverified — automated lookups against openrouter.ai/api/v1/models gave
  // inconsistent numbers across attempts for this specific id; taken from the
  // user's own browser view of the model's page. Double-check against your
  // OpenRouter dashboard's actual usage/cost if this run's estimated cost
  // looks off.
  "openai/gpt-5.5": { inputPerMillionUsd: 5, outputPerMillionUsd: 30 },
  // Real catalog id has a leading "~" (OpenRouter's auto-router-alias notation)
  // — it's not a typo, and the key here must match the literal model string
  // sent in requests or cost lookups silently miss.
  "~anthropic/claude-haiku-latest": { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
};

export function estimateCostUsd(
  deploymentOrModel: string,
  tokenUsage: { promptTokens: number; completionTokens: number }
): number | undefined {
  const pricing = PRICING_USD_PER_MILLION_TOKENS[deploymentOrModel];
  if (!pricing) return undefined;

  return (
    (tokenUsage.promptTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (tokenUsage.completionTokens / 1_000_000) * pricing.outputPerMillionUsd
  );
}
