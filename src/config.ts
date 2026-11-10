// Central configuration. Loads .env (Node >= 20.12 has a built-in loader, so no dotenv dependency).
try {
  process.loadEnvFile?.('.env');
} catch {
  /* no .env file — fall back to the real environment */
}

const env = (k: string, d = '') => (process.env[k] ?? '').trim() || d;

/**
 * LLM providers. Anthropic uses its native API; everything else speaks the OpenAI-compatible
 * Chat Completions protocol, so free options (Gemini free tier, Groq free tier, a local Ollama) work too.
 */
export type ProviderName = 'anthropic' | 'gemini' | 'groq' | 'openrouter' | 'openai';

const PRESETS: Record<ProviderName, { keyVar: string; baseUrl: string; model: string; fastModel: string }> = {
  anthropic: { keyVar: 'ANTHROPIC_API_KEY', baseUrl: '', model: 'claude-sonnet-5-5', fastModel: 'claude-haiku-5-5' },
  gemini: { keyVar: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash-lite', fastModel: 'gemini-3.5-flash-lite' },
  groq: { keyVar: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', fastModel: 'openai/gpt-oss-20b' },
  openrouter: { keyVar: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', model: '', fastModel: '' },
  // Any other OpenAI-compatible server, e.g. a local Ollama: OPENAI_BASE_URL=http://localhost:11434/v1
  openai: { keyVar: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', model: '', fastModel: '' },
};

function pickProvider(): ProviderName {
  const explicit = env('LLM_PROVIDER').toLowerCase() as ProviderName;
  if (explicit && explicit in PRESETS) return explicit;
  // Otherwise: the first provider whose key is present.
  for (const p of Object.keys(PRESETS) as ProviderName[]) if (env(PRESETS[p].keyVar)) return p;
  if (env('OPENAI_BASE_URL')) return 'openai'; // keyless local server (Ollama, LM Studio)
  return 'anthropic';
}

const provider = pickProvider();
const preset = PRESETS[provider];

export const config = {
  provider,
  llmKey: env(preset.keyVar),
  llmKeyVar: preset.keyVar,
  baseUrl: env('OPENAI_BASE_URL', preset.baseUrl).replace(/\/$/, ''),
  model: env('MODEL', preset.model),
  fastModel: env('FAST_MODEL', env('MODEL', preset.fastModel || preset.model)),
  effort: env('EFFORT', 'medium') as 'low' | 'medium' | 'high',
  /** Optional reasoning_effort for OpenAI-compatible reasoning models; unset = provider default. */
  reasoningEffort: env('REASONING_EFFORT'),
  tavilyKey: env('TAVILY_API_KEY'),
  braveKey: env('BRAVE_API_KEY'),
  port: Number(env('PORT', '3000')),
  defaultTz: env('DEFAULT_TZ', 'UTC'),
  agentNow: env('AGENT_NOW'),
  dataFile: env('DATA_FILE', 'data/store.json'),
  /** Background memory distillation costs one extra cheap call per turn; can be turned off on tight free quotas. */
  distill: env('DISTILL', 'on') !== 'off',
  /** Hard cap on search rounds per turn: keeps latency bounded. */
  maxSearchRounds: 3,
  /** Verbatim turns of the current conversation sent to the model. Older ones are reachable via recall. */
  historyTurns: 10,
};

export function missingKeys(): string[] {
  const out: string[] = [];
  const keyless = config.provider === 'openai' && !!env('OPENAI_BASE_URL'); // local servers need no key
  if (!config.llmKey && !keyless) out.push('an LLM key (GEMINI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY, …)');
  if (!config.model) out.push('MODEL (required for this provider)');
  if (!config.tavilyKey && !config.braveKey) out.push('TAVILY_API_KEY (or BRAVE_API_KEY)');
  return out;
}
