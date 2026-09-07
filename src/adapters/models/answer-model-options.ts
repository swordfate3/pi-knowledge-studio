import type { GroundedModelOptions } from "./grounded-model.ts";

/** Host opt-in only. No endpoint detection or server configuration changes. */
export interface AnswerGenerationProfile {
  readonly protocol: "llama.cpp";
  readonly maxTokens?: number;
  readonly enableThinking?: boolean;
  readonly reasoningBudgetTokens?: number;
}
export interface AnswerModelOptions extends GroundedModelOptions {
  readonly generation?: AnswerGenerationProfile;
}

// Conservative host limits, not claims about server context capacity.
export const ANSWER_TOKEN_CAP = 32768;

export function answerGenerationPayload(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid answer generation profile");
  const profile = value as Record<string, unknown>;
  if (profile.protocol !== "llama.cpp" || Object.keys(profile).some(key =>
    !["protocol", "maxTokens", "enableThinking", "reasoningBudgetTokens"].includes(key)))
    throw new Error("Unsupported answer generation profile or control");
  for (const [key, min] of [["maxTokens", 1], ["reasoningBudgetTokens", 0]] as const) {
    const number = profile[key];
    if (number !== undefined && (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > ANSWER_TOKEN_CAP))
      throw new Error(`Invalid answer generation ${key}: expected integer ${min}..${ANSWER_TOKEN_CAP}`);
  }
  if (profile.enableThinking !== undefined && typeof profile.enableThinking !== "boolean")
    throw new Error("Invalid answer generation enableThinking: expected boolean");
  return Object.freeze({
    ...(profile.maxTokens === undefined ? {} : { max_tokens: profile.maxTokens }),
    ...(profile.enableThinking === undefined ? {} : { chat_template_kwargs: Object.freeze({ enable_thinking: profile.enableThinking }) }),
    ...(profile.reasoningBudgetTokens === undefined ? {} : { reasoning_budget_tokens: profile.reasoningBudgetTokens }),
  });
}

/** Parse only the registration-time host snapshot; never tool arguments. */
export function answerGenerationFromEnv(env: Readonly<Record<string, string | undefined>>): AnswerGenerationProfile | undefined {
  const prefix = "PI_KS_V2_GENERATE_";
  const supported = ["ENDPOINT", "MODEL", "API_KEY", "TIMEOUT_MS", "PROTOCOL", "MAX_TOKENS", "ENABLE_THINKING", "REASONING_BUDGET_TOKENS"];
  if (Object.keys(env).some(key => key.startsWith(prefix) && !supported.includes(key.slice(prefix.length))))
    throw new Error("Unsupported host answer generation setting");
  const protocol = env[`${prefix}PROTOCOL`];
  const max = env[`${prefix}MAX_TOKENS`];
  const thinking = env[`${prefix}ENABLE_THINKING`];
  const budget = env[`${prefix}REASONING_BUDGET_TOKENS`];
  if (protocol === undefined && max === undefined && thinking === undefined && budget === undefined) return undefined;
  if (protocol !== "llama.cpp") throw new Error("Host answer generation controls require PROTOCOL=llama.cpp");
  const integer = (raw: string, key: string): number => {
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`Host answer generation ${key} must be a strict integer`);
    return Number(raw);
  };
  if (thinking !== undefined && thinking !== "true" && thinking !== "false")
    throw new Error("Host answer generation ENABLE_THINKING must be true or false");
  const profile: AnswerGenerationProfile = Object.freeze({
    protocol,
    ...(max === undefined ? {} : { maxTokens: integer(max, "MAX_TOKENS") }),
    ...(thinking === undefined ? {} : { enableThinking: thinking === "true" }),
    ...(budget === undefined ? {} : { reasoningBudgetTokens: integer(budget, "REASONING_BUDGET_TOKENS") }),
  });
  answerGenerationPayload(profile);
  return profile;
}
