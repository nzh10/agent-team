// Web sessions have no way to answer Git's terminal credential prompts.
// Keep explicit settings (including an empty string) and leave helpers and SSH alone.
export function applyNonInteractiveGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GIT_TERMINAL_PROMPT: env.GIT_TERMINAL_PROMPT ?? "0" };
}
