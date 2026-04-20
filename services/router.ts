/**
 * Nexus AI Gateway - Model Routing Registry
 *
 * Maps requested model identifiers to the set of providers that can actually
 * serve them. This prevents routing an `openai/*` model to Groq, a `groq/*`
 * model to OpenRouter, etc.
 *
 * Rules:
 *  - Match by known prefix (e.g. `openai/`, `anthropic/`, `google/`).
 *  - Or by literal family prefix (e.g. `gpt-`, `claude-`, `gemini-`, `llama-`).
 *  - A provider set is "universal" when the model has no recognizable prefix
 *    (then we fall back to every configured provider — this preserves the
 *    legacy behavior of "no model specified -> try whatever is healthy").
 */

import type { ProviderType } from '../types';

type PrefixRule = {
  test: (model: string) => boolean;
  providers: ProviderType[];
  label: string;
  /**
   * Per-provider model alias: when a fallback provider receives a model string
   * it cannot understand (e.g. "openai/gpt-4.1-mini" sent to Groq), remap it
   * to a native model that supports the same capabilities.
   * Keys are ProviderType values; absence means "use the model string as-is".
   */
  modelAliases?: Partial<Record<ProviderType, string>>;
};

const starts = (prefix: string) => (m: string) => m.startsWith(prefix);

const RULES: PrefixRule[] = [
  // OpenAI family -> OpenRouter first, then Gemini + Groq as circuit-breaker fallbacks.
  // Gemini ignores options.model (uses GEMINI_MODEL env), so no alias needed there.
  // Groq would 400 on "openai/*" / "gpt-*" strings, so alias to a capable Groq model.
  {
    label: 'openai/*',
    test: starts('openai/'),
    providers: ['openrouter', 'gemini', 'groq'],
    modelAliases: { groq: 'llama-3.3-70b-versatile' },
  },
  {
    label: 'gpt-*',
    test: starts('gpt-'),
    providers: ['openrouter', 'gemini', 'groq'],
    modelAliases: { groq: 'llama-3.3-70b-versatile' },
  },
  { label: 'o1-*',          test: starts('o1-'),          providers: ['openrouter'] },
  { label: 'o3-*',          test: starts('o3-'),          providers: ['openrouter'] },
  { label: 'o4-*',          test: starts('o4-'),          providers: ['openrouter'] },

  // Anthropic family -> OpenRouter (no native Anthropic provider wired)
  { label: 'anthropic/*',   test: starts('anthropic/'),   providers: ['openrouter'] },
  { label: 'claude-*',      test: starts('claude-'),      providers: ['openrouter'] },

  // Google/Gemini family -> native Gemini + OpenRouter proxy
  { label: 'google/*',      test: starts('google/'),      providers: ['gemini', 'openrouter'] },
  { label: 'gemini-*',      test: starts('gemini-'),      providers: ['gemini', 'openrouter'] },

  // Groq-hosted open-weight families
  { label: 'groq/*',        test: starts('groq/'),        providers: ['groq'] },
  { label: 'llama-*',       test: starts('llama-'),       providers: ['groq', 'openrouter'] },
  { label: 'meta-llama/*',  test: starts('meta-llama/'),  providers: ['groq', 'openrouter'] },
  { label: 'mixtral-*',     test: starts('mixtral-'),     providers: ['groq', 'openrouter'] },
  { label: 'moonshotai/*',  test: starts('moonshotai/'),  providers: ['groq', 'openrouter'] },
  { label: 'kimi-*',        test: starts('kimi-'),        providers: ['groq', 'openrouter'] },

  // DeepSeek / Qwen / misc open-source -> OpenRouter
  { label: 'deepseek/*',    test: starts('deepseek/'),    providers: ['openrouter'] },
  { label: 'deepseek-*',    test: starts('deepseek-'),    providers: ['openrouter'] },
  { label: 'qwen/*',        test: starts('qwen/'),        providers: ['openrouter'] },
  { label: 'qwen-*',        test: starts('qwen-'),        providers: ['openrouter'] },
  { label: 'mistralai/*',   test: starts('mistralai/'),   providers: ['openrouter'] },
  { label: 'nousresearch/*',test: starts('nousresearch/'),providers: ['openrouter'] },

  // Cerebras hosts zai and cerebras/* aliases
  { label: 'zai-*',         test: starts('zai-'),         providers: ['cerebras'] },
  { label: 'zai/*',         test: starts('zai/'),         providers: ['cerebras'] },
  { label: 'cerebras/*',    test: starts('cerebras/'),    providers: ['cerebras'] },
  { label: 'glm-*',         test: starts('glm-'),         providers: ['cerebras', 'openrouter'] },
];

export interface ResolvedRoute {
  /** Providers allowed for this request */
  providers: ReadonlySet<ProviderType>;
  /** True when the model didn't match any rule -> caller may fall back to all providers */
  isUniversal: boolean;
  /** Human-readable rule label used for logging */
  ruleLabel: string;
  /**
   * Per-provider model alias map (may be empty).
   * When the original model string is incompatible with a fallback provider,
   * use the alias instead of forwarding the original string.
   */
  modelAliases: Partial<Record<ProviderType, string>>;
}

const ALL_PROVIDERS: ProviderType[] = ['groq', 'gemini', 'openrouter', 'cerebras'];

/**
 * Resolve which providers can serve a given model string.
 * - Returns a universal route (all providers) if `model` is missing or unrecognized.
 *   Rationale: each provider has its own default model configured, so a bare
 *   request without `model` should behave like it did before this router.
 */
export function resolveRoute(model?: string): ResolvedRoute {
  if (!model || typeof model !== 'string' || model.trim().length === 0) {
    return {
      providers: new Set(ALL_PROVIDERS),
      isUniversal: true,
      ruleLabel: 'no-model (universal)',
      modelAliases: {},
    };
  }

  const normalized = model.trim().toLowerCase();
  for (const rule of RULES) {
    if (rule.test(normalized)) {
      return {
        providers: new Set(rule.providers),
        isUniversal: false,
        ruleLabel: rule.label,
        modelAliases: rule.modelAliases ?? {},
      };
    }
  }

  // Unknown model: keep legacy behavior (universal) but flag as unrecognized
  return {
    providers: new Set(ALL_PROVIDERS),
    isUniversal: true,
    ruleLabel: 'unrecognized (fallback to all)',
    modelAliases: {},
  };
}

/** Flat list of all known providers, for error messages */
export function listAllProviders(): ProviderType[] {
  return [...ALL_PROVIDERS];
}
