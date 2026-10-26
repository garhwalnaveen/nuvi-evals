import { describe, expect, test } from "bun:test";

import { prepareAzureCredentials } from "../azure-credentials";

function environment(): NodeJS.ProcessEnv {
  return {
    EVALS_LLM_PROVIDER: "azure",
    EVALS_AZURE_RESOURCE_GROUP: "example-group",
    EVALS_AZURE_RESOURCE_NAME: "example-resource",
    AZURE_OPENAI_ENDPOINT:
      "https://example-resource.openai.azure.com/openai/v1",
  };
}

describe("prepareAzureCredentials", () => {
  test("loads the named resource through the reader and replaces a stale environment key", async () => {
    const env = { ...environment(), AZURE_OPENAI_API_KEY: "stale-test-key" };
    let called = false;
    const source = await prepareAzureCredentials(env, async (group, name) => {
      expect(group).toBe("example-group");
      expect(name).toBe("example-resource");
      called = true;
      return JSON.stringify({
        key1: "fresh-test-key",
        key2: "unused-test-key",
      });
    });
    expect(called).toBe(true);
    expect(source).toBe("azure-cli");
    expect(env.AZURE_OPENAI_API_KEY).toBe("fresh-test-key");
  });

  test("keeps explicit environment credentials when resource lookup is not configured", async () => {
    const env = {
      EVALS_LLM_PROVIDER: "azure",
      AZURE_OPENAI_API_KEY: "test-key",
    };
    expect(
      await prepareAzureCredentials(env, async () => {
        throw new Error("must not access Azure");
      }),
    ).toBe("environment");
    expect(env.AZURE_OPENAI_API_KEY).toBe("test-key");
  });

  test("does not fetch credentials for another provider", async () => {
    expect(
      await prepareAzureCredentials(
        { ...environment(), EVALS_LLM_PROVIDER: "anthropic" },
        async () => {
          throw new Error("must not access Azure");
        },
      ),
    ).toBe("not-applicable");
  });

  test("rejects partial resource configuration", async () => {
    const env = environment();
    delete env.EVALS_AZURE_RESOURCE_GROUP;
    await expect(prepareAzureCredentials(env)).rejects.toThrow("Set both");
  });

  test.each([
    "https://other-resource.openai.azure.com/openai/v1",
    "https://example-resource.openai.azure.com.example.org/openai/v1",
    "http://example-resource.openai.azure.com",
    "https://user:secret@example-resource.openai.azure.com",
  ])("refuses to load a key for mismatched endpoint %s", async (endpoint) => {
    let called = false;
    const env = { ...environment(), AZURE_OPENAI_ENDPOINT: endpoint };
    await expect(
      prepareAzureCredentials(env, async () => {
        called = true;
        return JSON.stringify({ key1: "test-key" });
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  test.each(["not json", "{}", '{"key1":""}', '{"key1":"has whitespace"}'])(
    "rejects malformed key responses without disclosing them",
    async (raw) => {
      const env = environment();
      await expect(
        prepareAzureCredentials(env, async () => raw),
      ).rejects.toThrow();
      expect(env.AZURE_OPENAI_API_KEY).toBeUndefined();
    },
  );

  test("does not expose subprocess errors or change credentials on failure", async () => {
    const env = { ...environment(), AZURE_OPENAI_API_KEY: "existing-test-key" };
    try {
      await prepareAzureCredentials(env, async () => {
        throw new Error("secret-provider-output");
      });
      throw new Error("expected credential error");
    } catch (error) {
      expect(error instanceof Error && error.message).toBe(
        "Could not load Azure eval credentials. Check az login and resource-key permissions.",
      );
    }
    expect(env.AZURE_OPENAI_API_KEY).toBe("existing-test-key");
  });
});
