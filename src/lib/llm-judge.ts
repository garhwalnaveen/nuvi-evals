import {
  DEFAULT_ANTHROPIC_MODEL,
  requestHarnessCompletion,
  resolveHarnessLlmConfig,
  type HarnessLlmOptions,
} from "./harness-llm";

export const DEFAULT_JUDGE_MODEL = DEFAULT_ANTHROPIC_MODEL;
const JUDGE_MAX_TOKENS = 1024;
const AZURE_JUDGE_MAX_TOKENS = 4096;

export interface JudgeToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface JudgeRequest extends HarnessLlmOptions {
  /** System prompt framing the grading task. */
  system: string;
  /** User-role content the judge inspects (e.g. the assistant's answer). */
  user: string;
  /** The single tool the judge is forced to call to return its verdict. */
  tool: JudgeToolSpec;
}

/**
 * Run one judge call and return the forced tool call's input. Throws if the
 * API key is missing, the request fails, or the response carries no matching
 * `tool_use` block.
 */
export async function classifyWithJudge(
  request: JudgeRequest,
): Promise<Record<string, unknown>> {
  const llm = resolveHarnessLlmConfig(request);
  const body = await requestHarnessCompletion(llm, {
    purpose: "judge",
    failureLabel: "LLM judge request",
    maxTokens:
      llm.provider === "azure" ? AZURE_JUDGE_MAX_TOKENS : JUDGE_MAX_TOKENS,
    system: request.system,
    messages: [{ role: "user", content: request.user }],
    tools: [
      {
        name: request.tool.name,
        description: request.tool.description,
        input_schema: request.tool.inputSchema,
      },
    ],
    toolChoice: { type: "tool", name: request.tool.name },
  });
  const toolUse = (body.content ?? []).find(
    (part) => part.type === "tool_use" && part.name === request.tool.name,
  );
  if (toolUse?.type !== "tool_use" || !toolUse.input) {
    throw new Error(
      `LLM judge returned no ${request.tool.name} tool call (content: ${JSON.stringify(body.content ?? [])})`,
    );
  }
  return toolUse.input;
}
