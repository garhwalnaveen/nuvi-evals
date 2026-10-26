import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  requestHarnessCompletion,
  resolveHarnessLlmConfig,
  withHarnessUsage,
  type HarnessCompletionRequest,
} from "../harness-llm";
import { classifyWithJudge } from "../llm-judge";
import { UserSimulator } from "../simulator/user-simulator";
import { loadTestDef } from "../test-def";

const options = {
  provider: "azure",
  apiKey: "test-key",
  endpoint: "https://resource.example.com/openai/v1",
} satisfies Parameters<typeof resolveHarnessLlmConfig>[0];
const config = resolveHarnessLlmConfig(options, {});
const request: HarnessCompletionRequest = {
  purpose: "simulator",
  failureLabel: "Simulator request",
  system: "Follow the supplied test.",
  messages: [{ role: "user", content: "Start." }],
  tools: [
    {
      name: "end_conversation",
      description: "End the conversation.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  ],
  maxTokens: 8192,
};

function response(output: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "resp-123",
    model: "gpt-6-astra",
    status: "completed",
    output,
    usage: {
      input_tokens: 20,
      output_tokens: 30,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 15 },
    },
    ...extra,
  };
}

function functionCall(name: string, args: Record<string, unknown>) {
  return { type: "function_call", name, arguments: JSON.stringify(args) };
}

function mockResponse(body: unknown) {
  const calls: Array<{
    url: string;
    init?: RequestInit;
    body: Record<string, unknown>;
  }> = [];
  const fetchResponse = async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const parsed = z
      .record(z.string(), z.unknown())
      .safeParse(JSON.parse(String(init?.body)));
    if (!parsed.success) {
      throw new Error("Invalid request fixture");
    }
    calls.push({ url: String(url), init, body: parsed.data });
    return Response.json(body);
  };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(fetchResponse, { preconnect: globalThis.fetch.preconnect }),
  );
  return calls;
}

const temporaryDirs: string[] = [];
afterEach(async () => {
  mock.restore();
  for (const path of temporaryDirs.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("Azure harness configuration", () => {
  test("uses the exact Astra default and never falls back to Anthropic", () => {
    expect(config).toMatchObject({
      provider: "azure",
      model: "gpt-6-astra",
      url: "https://resource.example.com/openai/v1/responses",
    });
    expect(() =>
      resolveHarnessLlmConfig(
        {},
        {
          EVALS_LLM_PROVIDER: "azure",
          ANTHROPIC_API_KEY: "other-provider-key",
        },
      ),
    ).toThrow("AZURE_OPENAI_API_KEY is required");
  });

  test("resolves the configured deployment from the environment", () => {
    expect(
      resolveHarnessLlmConfig(
        {},
        {
          EVALS_LLM_PROVIDER: "azure",
          AZURE_OPENAI_API_KEY: "test-key",
          AZURE_OPENAI_ENDPOINT: options.endpoint,
          AZURE_OPENAI_DEPLOYMENT: "astra-deployment",
        },
      ).model,
    ).toBe("astra-deployment");
  });

  test.each([
    "https://resource.example.com",
    "https://resource.example.com/",
    "https://resource.example.com/openai/v1/",
    "https://resource.example.com/openai/v1/responses",
  ])("normalizes endpoint %s without duplicating paths", (endpoint) => {
    expect(resolveHarnessLlmConfig({ ...options, endpoint }, {}).url).toBe(
      "https://resource.example.com/openai/v1/responses",
    );
  });

  test.each([
    "http://resource.example.com",
    "https://user:secret@resource.example.com",
    "https://resource.example.com?api-key=secret",
    "https://resource.example.com/openai/deployments/astra",
  ])("rejects unsafe or unsupported endpoint %s", (endpoint) => {
    expect(() =>
      resolveHarnessLlmConfig({ ...options, endpoint }, {}),
    ).toThrow();
  });
});

describe("Azure Responses transport", () => {
  test("sends tools through Responses without unsupported sampling or storage", async () => {
    const calls = mockResponse(
      response([
        { type: "reasoning" },
        { type: "message", content: [{ type: "output_text", text: "Hello." }] },
      ]),
    );
    const result = await requestHarnessCompletion(config, request);
    expect(result.content).toEqual([{ type: "text", text: "Hello." }]);
    expect(calls[0].url).toBe(config.url);
    expect(new Headers(calls[0].init?.headers).get("api-key")).toBe("test-key");
    expect(new Headers(calls[0].init?.headers).has("x-api-key")).toBe(false);
    expect(calls[0].init?.redirect).toBe("error");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].body).toMatchObject({
      model: "gpt-6-astra",
      store: false,
      reasoning: { effort: "low" },
      max_output_tokens: 8192,
      instructions: request.system,
      input: request.messages,
      parallel_tool_calls: false,
      tools: [
        {
          type: "function",
          name: "end_conversation",
          parameters: request.tools[0].input_schema,
          strict: false,
        },
      ],
    });
    expect(calls[0].body).not.toHaveProperty("temperature");
    expect(calls[0].body).not.toHaveProperty("max_tokens");
    expect(calls[0].body).not.toHaveProperty("tool_choice");
  });

  test("normalizes a forced function decision", async () => {
    const calls = mockResponse(
      response([functionCall("end_conversation", { reason: "done" })]),
    );
    const result = await requestHarnessCompletion(config, {
      ...request,
      toolChoice: { type: "tool", name: "end_conversation" },
    });
    expect(result.content).toEqual([
      { type: "tool_use", name: "end_conversation", input: { reason: "done" } },
    ]);
    expect(calls[0].body.tool_choice).toEqual({
      type: "function",
      name: "end_conversation",
    });
  });

  test.each(["not JSON", "[]", "null"])(
    "rejects invalid tool arguments: %s",
    async (args) => {
      mockResponse(
        response([
          { type: "function_call", name: "end_conversation", arguments: args },
        ]),
      );
      await expect(requestHarnessCompletion(config, request)).rejects.toThrow(
        /tool (JSON|arguments)/,
      );
    },
  );

  test("does not treat a truncated answer as successful completion", async () => {
    mockResponse(
      response([], {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    );
    await expect(requestHarnessCompletion(config, request)).rejects.toThrow(
      "response incomplete: max_output_tokens",
    );
  });

  test("does not synthesize a decision from empty output", async () => {
    mockResponse(response([{ type: "reasoning" }]));
    await expect(requestHarnessCompletion(config, request)).rejects.toThrow(
      "no text or tool decision",
    );
  });

  test("surfaces refusals rather than sending them as simulated user text", async () => {
    mockResponse(
      response([
        {
          type: "message",
          content: [{ type: "refusal", refusal: "Refused." }],
        },
      ]),
    );
    await expect(requestHarnessCompletion(config, request)).rejects.toThrow(
      "was refused",
    );
  });

  test("validates provider response fields", async () => {
    mockResponse(response([{ type: "message", content: "not an array" }]));
    await expect(requestHarnessCompletion(config, request)).rejects.toThrow(
      "invalid response structure",
    );
  });

  test("does not expose provider error bodies or retry failed calls", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("echoed-secret-and-input", { status: 429 }),
    );
    await expect(requestHarnessCompletion(config, request)).rejects.toThrow(
      "Simulator request failed 429",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("keeps concurrent usage journals separate and marks cost unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-harness-"));
    temporaryDirs.push(dir);
    mockResponse(
      response([functionCall("end_conversation", { reason: "done" })]),
    );
    await Promise.all(
      ["first", "second"].map((name) =>
        withHarnessUsage(join(dir, `${name}.jsonl`), () =>
          requestHarnessCompletion(config, request),
        ),
      ),
    );
    for (const name of ["first", "second"]) {
      const raw = await readFile(join(dir, `${name}.jsonl`), "utf8");
      const parsed = z
        .object({
          provider: z.string(),
          requestedModel: z.string(),
          returnedModel: z.string(),
          usage: z.object({
            input_tokens: z.number(),
            output_tokens: z.number(),
          }),
          costUsd: z.null(),
          costStatus: z.literal("unpriced"),
        })
        .safeParse(JSON.parse(raw));
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error("Invalid journal fixture");
      }
      expect(parsed.data.requestedModel).toBe("gpt-6-astra");
      expect(parsed.data.usage).toEqual({
        input_tokens: 20,
        output_tokens: 30,
      });
      expect(raw).not.toContain("test-key");
      expect(raw).not.toContain(request.system);
      expect(raw.trim().split("\n")).toHaveLength(1);
    }
  });
});

describe("Azure simulator and judge integration", () => {
  test("uses Astra for normal simulator turns and end decisions", async () => {
    mockResponse(
      response([functionCall("end_conversation", { reason: "answered" })]),
    );
    const simulator = new UserSimulator(options);
    const decision = await simulator.decide({
      test: await loadTestDef("timeline-recall"),
      transcript: [],
    });
    expect(decision).toEqual({ action: "end", reason: "answered" });
  });

  test("preserves the simulator's structured deny decision", async () => {
    const calls = mockResponse(
      response([
        functionCall("respond_to_confirmation", {
          decision: "deny",
          reason: "off-task",
        }),
      ]),
    );
    const simulator = new UserSimulator(options);
    const decision = await simulator.decide({
      test: await loadTestDef("timeline-recall"),
      transcript: [],
      pendingConfirmation: {
        toolName: "WriteFile",
        input: { path: "/etc/hosts" },
      },
    });
    expect(decision).toEqual({
      action: "confirm",
      decision: "deny",
      reason: "off-task",
    });
    expect(calls[0].body.tool_choice).toEqual({
      type: "function",
      name: "respond_to_confirmation",
    });
  });

  test("uses Astra and the requested tool for judge classification", async () => {
    const calls = mockResponse(
      response([functionCall("grade", { correct: true })]),
    );
    const verdict = await classifyWithJudge({
      ...options,
      system: "Grade the supplied answer.",
      user: "2 + 2 = 4",
      tool: {
        name: "grade",
        description: "Return correctness.",
        inputSchema: {
          type: "object",
          properties: { correct: { type: "boolean" } },
          required: ["correct"],
        },
      },
    });
    expect(verdict).toEqual({ correct: true });
    expect(calls[0].body.model).toBe("gpt-6-astra");
    expect(calls[0].body.max_output_tokens).toBe(4096);
    expect(calls[0].body.tool_choice).toEqual({
      type: "function",
      name: "grade",
    });
  });
});
