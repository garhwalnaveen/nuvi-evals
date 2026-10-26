import { describe, expect, test } from "bun:test";
import { loadCloudflareCredentials } from "../cloudflare-credentials";

const env = { EVALS_CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) };
const model = "@cf/example/model";

describe("Cloudflare eval credentials", () => {
  test("loads credentials without changing the process environment", async () => {
    const result = await loadCloudflareCredentials(
      [model, model],
      env,
      async (command) => {
        expect(command).toBe("wrangler");
        return JSON.stringify({ type: "oauth", token: "test-token" });
      },
    );
    expect(result).toEqual({
      accountId: "0".repeat(32),
      token: "test-token",
      models: [model],
    });
    expect(env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
  });

  test("validates the account before reading credentials", async () => {
    let called = false;
    await expect(
      loadCloudflareCredentials([model], {}, async () => {
        called = true;
        return "";
      }),
    ).rejects.toThrow("account ID");
    expect(called).toBe(false);
  });

  test("redacts credential-reader failures", async () => {
    await expect(
      loadCloudflareCredentials([model], env, async () => {
        throw new Error("secret-provider-output");
      }),
    ).rejects.toThrow("Could not load Cloudflare eval credentials");
  });

  test.each(["{}", "null", '{"token":""}', "invalid"])(
    "rejects malformed response %s",
    async (raw) => {
      await expect(
        loadCloudflareCredentials([model], env, async () => raw),
      ).rejects.toThrow();
    },
  );
});
