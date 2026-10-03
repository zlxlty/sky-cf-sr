/**
 * The models every router in the comparison may choose from: the Auto Router
 * through `cf-aig-allowed-models`, and this Worker's own policy through its
 * model catalogue. One list keeps the comparison fair.
 */
export const POOL = [
  "openai/gpt-5.6-luna",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/qwen/qwen3.8-27b",
  "@cf/moonshotai/kimi-k2.7-code",
  "anthropic/claude-opus-5.5",
  "openai/gpt-6-sol",
];
