import { TrueForge } from "@truefoundry/trueforge-sdk";

/**
 * Read an env var, treating blank as unset.
 *
 * `.env.example` ships every key with an empty value, so copying it to
 * `.env.local` defines the names with empty strings. `??` only falls back on
 * undefined, so without this an untouched copy sets baseUrl to "" and every
 * request fails with "Failed to parse URL".
 */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Server-side TrueForge client. The SDK talks to the local harness, and this
 * module never runs in the browser, so the token stays on the server.
 */
export function createClient(): TrueForge {
  const token = env("TRUEFORGE_API_KEY");
  return new TrueForge({
    baseUrl: env("TRUEFORGE_BASE_URL") ?? "http://localhost:8790",
    timeoutInSeconds: 600,
    ...(token ? { token } : {}),
  });
}

/**
 * The agent we drive. Defined inline rather than as a saved agent so a fresh
 * clone runs without anyone configuring an agent in the TrueForge UI first.
 *
 * `requireApprovalForTools` is deliberately left unset. TrueForge defaults it
 * to ["@write", "@destructive"], where a tool is @write when readOnlyHint is
 * explicitly false and @destructive when destructiveHint is true. Our MCP
 * server annotates only publish_post as destructive and omits readOnlyHint on
 * the ordinary write tools, so the default gates publish_post and nothing else.
 */
export function agentSpec() {
  return {
    model: {
      name: env("TRUEFORGE_MODEL") ?? "anthropic/claude-sonnet-5",
    },
    config: {
      // Without this the agent reaches the last step, calls the built-in
      // ask_user_question to confirm the caption, and emits
      // tool.response_required instead of tool.approval_required. That is a
      // different pause with a different resume shape, and it stops the run
      // short of the approval gate this app exists to demonstrate.
      askUserQuestions: { enabled: false },
    },
    instructions:
      "You are a daily content agent for a creator. Use the available tools to do the work rather than describing what you would do. Never stop to ask the operator a question: make a reasonable choice from the information you have and keep going. Take one step at a time and keep your reasoning short.",
    mcpServers: [
      {
        // Name of the connector in TrueForge Settings -> Connectors.
        name: env("TRUEFORGE_MCP_SERVER_NAME") ?? "yallapost2",
        preload: true,
      },
    ],
  };
}
