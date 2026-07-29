// Using one line version passed directly to spawn.sync since this version didn't work.
export const AGENT_SYSTEM_PROMPT = `
  You are a helpful assitant for another model. Your job is to assist this model when it 
  comes to planning and implementation details. You are using a more powerful llm model than the
  worker agent so you should be the one it relies on for important details like patterns, architecture,
  high level implementation, etc. 
  
  ## Your Job

  The worker agent will summarize the problem, context, and its plan. Your job is to recieve its plan,
  analyze it, think back in your training data to concepts referenced in the workers plan
  and respond with what you think. You can either agree with the worker agent, or propose updates
  to its plan, or flat out disagree with the agent and tell it do it or another way.

  ## What not to do

  Your purpose is not project specific, or to be a code validator, you shouldn't need to worry about direct implementation 
  details like which files to edit. It is to act as a senior engineer, and nudge the worker in the
  right direction. Make sure they are using concepts properly, aren't overcomplicating things. It's
  to make sure there plan is correct and idiomatic, not that their code is correct.

  ## Last Notes

  You should analyze each step of the worker agent's plan, when you respond, make sure you reference
  each step, whether it needs to be changed or remain the same and give your reasoning + evidence.
`;

// ── Model registry ──────────────────────────────────────────────────
// Index into these arrays to swap providers/models without retyping in DEFAULT_PI_ARGS.
export const PROVIDERS = [
  "deepseek", // 0
  "nano-gpt", // 1
];
export const MODELS = [
  "deepseek/deepseek-v4-pro", // 0
  "deepseek/deepseek-v4-flash", // 1
  "tencent/hy3",              // 2
];

// ── Prompt helpers ───────────────────────────────────────────────────
// Flatten a multi-line template-string prompt into a single line by
// replacing newlines (and collapsing runs of whitespace) with spaces.
export function flattenPrompt(prompt) {
  return prompt
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Default args used by start_session
export const DEFAULT_PI_ARGS = [
  "--mode", "rpc", "--provider", PROVIDERS[0], "--model", MODELS[0], 
  "--no-tools", "--no-extensions", "--no-skills", "--no-context-files",
  "--system-prompt",
  flattenPrompt(AGENT_SYSTEM_PROMPT)
];

export const RPC_CWD = process.cwd();
export const PI_SESSION_DIR = process.env.PI_SESSION_DIR;

// ── Text sanitizer ───────────────────────────────────────────────────────
// Strips non-printable / non-regular text characters that can cause problems
// with the Pi RPC protocol over stdio: newlines, carriage returns, tabs,
// control characters, zero-width spaces, and other unusual Unicode.
// Replaces problematic whitespace with a single space, collapses runs, trims.
export function sanitizeText(text) {
  if (typeof text !== "string") return text;
  return text
    // Replace newlines, carriage returns, tabs with a space
    .replace(/[\r\n\t\f\v]+/g, " ")
    // Strip ASCII control characters (0x00-0x1F except tab/newline already handled, 0x7F DEL)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Strip zero-width and weird Unicode whitespace
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF\u00AD\u2060]/g, "")
    // Collapse runs of whitespace into a single space
    .replace(/\s+/g, " ")
    .trim();
}
