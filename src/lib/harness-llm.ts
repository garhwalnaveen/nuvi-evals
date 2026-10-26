import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import { z } from "zod";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_AZURE_MODEL = "gpt-6-astra";

export interface HarnessLlmOptions {
  provider?: "anthropic" | "azure";
  apiKey?: string;
  model?: string;
  endpoint?: string;
}

export interface HarnessLlmConfig {
  provider: "anthropic" | "azure";
  apiKey: string;
  model: string;
  url: string;
}

export interface HarnessCompletionRequest {
  purpose: "simulator" | "judge";
  failureLabel: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: Array<{
    name: string;
    description: string;
    input_schema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  }>;
  toolChoice?: { type: "tool"; name: string };
  maxTokens: number;
}

const contentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
]);
const completionSchema = z.object({
  content: z.array(contentPartSchema).optional(),
  stop_reason: z.string().optional(),
  id: z.string().optional(),
  model: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cache_read_input_tokens: z.number().int().nonnegative().optional(),
      cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    })
    .nullish(),
});
export type HarnessCompletion = z.infer<typeof completionSchema>;

const responsesSchema = z.object({
  id: z.string(),
  model: z.string(),
  status: z.string(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  output: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("reasoning") }),
      z.object({
        type: z.literal("message"),
        content: z.array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("output_text"), text: z.string() }),
            z.object({ type: z.literal("refusal"), refusal: z.string() }),
          ]),
        ),
      }),
      z.object({
        type: z.literal("function_call"),
        name: z.string(),
        arguments: z.string(),
      }),
    ]),
  ),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      input_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative() })
        .optional(),
      output_tokens_details: z
        .object({ reasoning_tokens: z.number().int().nonnegative() })
        .optional(),
    })
    .nullish(),
});

const usagePath = new AsyncLocalStorage<string>();

/** Records harness calls separately from the assistant's intercepted traffic. */
export function withHarnessUsage<T>(
  path: string,
  task: () => Promise<T>,
): Promise<T> {
  return usagePath.run(path, task);
}

export function resolveHarnessLlmConfig(
  options: HarnessLlmOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): HarnessLlmConfig {
  const provider = z
    .enum(["anthropic", "azure"])
    .safeParse(options.provider ?? env.EVALS_LLM_PROVIDER ?? "anthropic");
  if (!provider.success) {
    throw new Error("EVALS_LLM_PROVIDER must be anthropic or azure");
  }
  const keyName =
    provider.data === "azure" ? "AZURE_OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const apiKey = (options.apiKey ?? env[keyName])?.trim();
  if (!apiKey) {
    throw new Error(`${keyName} is required to run the eval harness`);
  }
  const model =
    options.model?.trim() ||
    env.EVALS_LLM_MODEL?.trim() ||
    (provider.data === "azure"
      ? env.AZURE_OPENAI_DEPLOYMENT?.trim() || DEFAULT_AZURE_MODEL
      : DEFAULT_ANTHROPIC_MODEL);
  if (provider.data === "anthropic") {
    return {
      provider: provider.data,
      apiKey,
      model,
      url: "https://api.anthropic.com/v1/messages",
    };
  }
  const endpoint = options.endpoint ?? env.AZURE_OPENAI_ENDPOINT;
  const parsed = z.url({ protocol: /^https$/ }).safeParse(endpoint);
  if (!parsed.success) {
    throw new Error(
      "AZURE_OPENAI_ENDPOINT must be an HTTPS Azure resource URL",
    );
  }
  const url = new URL(parsed.data);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "AZURE_OPENAI_ENDPOINT must not contain credentials or query parameters",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!["", "/openai/v1", "/openai/v1/responses"].includes(path)) {
    throw new Error(
      "AZURE_OPENAI_ENDPOINT must be a resource root or /openai/v1 URL",
    );
  }
  url.pathname = "/openai/v1/responses";
  return { provider: provider.data, apiKey, model, url: url.toString() };
}

export async function requestHarnessCompletion(
  config: HarnessLlmConfig,
  request: HarnessCompletionRequest,
): Promise<HarnessCompletion> {
  const azure = config.provider === "azure";
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const response = await fetch(config.url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
    headers: {
      "content-type": "application/json",
      ...(azure
        ? { "api-key": config.apiKey }
        : { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }),
    },
    body: JSON.stringify(
      azure
        ? {
            model: config.model,
            store: false,
            reasoning: { effort: "low" },
            max_output_tokens: request.maxTokens,
            instructions: request.system,
            input: request.messages,
            tools: request.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
              strict: false,
            })),
            parallel_tool_calls: false,
            ...(request.toolChoice
              ? {
                  tool_choice: {
                    type: "function",
                    name: request.toolChoice.name,
                  },
                }
              : {}),
          }
        : {
            model: config.model,
            max_tokens: request.maxTokens,
            temperature: 0,
            system: request.system,
            messages: request.messages,
            tools: request.tools,
            ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
          },
    ),
  });
  if (!response.ok) {
    // Provider error bodies can echo inputs or credentials.
    throw new Error(`${request.failureLabel} failed ${response.status}`);
  }
  const raw: unknown = await response.json();
  const parsed = azure
    ? responsesSchema.safeParse(raw)
    : completionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${request.failureLabel} returned an invalid response structure`,
    );
  }
  const path = usagePath.getStore();
  if (path) {
    await appendFile(
      path,
      JSON.stringify({
        startedAt,
        purpose: request.purpose,
        provider: config.provider,
        requestedModel: config.model,
        returnedModel: parsed.data.model ?? null,
        responseId: parsed.data.id ?? null,
        responseStatus:
          "status" in parsed.data
            ? parsed.data.status
            : (parsed.data.stop_reason ?? null),
        durationMs: Math.round(performance.now() - started),
        reasoningEffort: azure ? "low" : null,
        maxOutputTokens: request.maxTokens,
        usage: parsed.data.usage ?? null,
        costUsd: null,
        costStatus: "unpriced",
      }) + "\n",
      { mode: 0o600 },
    );
  }
  if (!("output" in parsed.data)) {
    return parsed.data;
  }
  const body = parsed.data;
  if (body.status !== "completed") {
    throw new Error(
      `${request.failureLabel} response ${body.status}` +
        (body.incomplete_details ? `: ${body.incomplete_details.reason}` : ""),
    );
  }
  const content: z.infer<typeof contentPartSchema>[] = [];
  for (const item of body.output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "refusal") {
          throw new Error(`${request.failureLabel} was refused`);
        }
        content.push({ type: "text", text: part.text });
      }
    } else if (item.type === "function_call") {
      let args: unknown;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        throw new Error(`${request.failureLabel} returned invalid tool JSON`);
      }
      const input = z.record(z.string(), z.unknown()).safeParse(args);
      if (!input.success) {
        throw new Error(
          `${request.failureLabel} returned non-object tool arguments`,
        );
      }
      content.push({ type: "tool_use", name: item.name, input: input.data });
    }
  }
  if (content.length === 0) {
    throw new Error(
      `${request.failureLabel} returned no text or tool decision`,
    );
  }
  return {
    content,
    stop_reason: content.some((part) => part.type === "tool_use")
      ? "tool_use"
      : "end_turn",
    model: body.model,
    id: body.id,
  };
}
