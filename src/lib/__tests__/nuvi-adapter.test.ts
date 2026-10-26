import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isolatedNuviRunner,
  NuviAgent,
  NUVI_RUNTIME_ALLOW_HOSTS,
} from "../adapters/nuvi";
import { runArtifacts } from "../metrics";
import { ProfileManifestSchema } from "../profile";
import type { CommandRunner, RunOptions } from "../runtime/command-runner";

describe("Nuvi adapter", () => {
  test("allows the memory runtime downloads without adding other inference providers", () => {
    expect(NUVI_RUNTIME_ALLOW_HOSTS).toEqual([
      "api.cloudflare.com",
      "registry.npmjs.org",
      "huggingface.co",
      "cas-bridge.xethub.hf.co",
      "us.aws.cdn.hf.co",
      "github.com",
      "release-assets.githubusercontent.com",
    ]);
  });

  test("validates explicit model configuration", () => {
    expect(
      ProfileManifestSchema.safeParse({
        species: "nuvi",
        cloudflare: {
          model: "@cf/example/model",
          auxiliaryModel: "@cf/example/aux",
        },
      }).success,
    ).toBe(true);
    expect(
      ProfileManifestSchema.safeParse({
        species: "nuvi",
        cloudflare: { model: "not-a-model", auxiliaryModel: "@cf/example/aux" },
      }).success,
    ).toBe(false);
  });

  test("rejects an unconfigured profile before creating runtime state", () => {
    expect(
      () =>
        new NuviAgent({
          profile: {
            id: "nuvi-test",
            manifest: { species: "nuvi" },
            workspaceDir: "/tmp/unused",
          },
          testId: "timeline-recall",
        }),
    ).toThrow("must declare Cloudflare models");
  });

  test("isolates CLI state for run and streaming commands without forwarding it to Docker", async () => {
    const calls: Array<{ command: string; options?: RunOptions }> = [];
    const base: CommandRunner = {
      run: async (command, _args, options) => {
        calls.push({ command, options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: (command, _args, options) => {
        calls.push({ command, options });
        return {
          stdout: (async function* () {})(),
          stderr: (async function* () {})(),
          wait: async () => 0,
          kill: () => {},
        };
      },
    };
    const scoped = isolatedNuviRunner(base, "nuvi", "/tmp/eval-state");
    await scoped.run("nuvi", ["hatch"], {
      env: { NUVI_LOCKFILE_DIR: "/tmp/personal" },
    });
    scoped.spawn("nuvi", ["events"]);
    await scoped.run("docker", ["info"]);
    for (const call of calls.slice(0, 2)) {
      expect(call.options?.env?.NUVI_LOCKFILE_DIR).toBe(
        "/tmp/eval-state/config",
      );
      expect(call.options?.env?.XDG_DATA_HOME).toBe("/tmp/eval-state/data");
    }
    expect(calls[2]?.options).toBeUndefined();
  });

  test.each([false, true])(
    "hatches Nuvi with isolated model credentials (local images: %s)",
    async (localImages) => {
      const calls: Array<{
        command: string;
        args: string[];
        options?: RunOptions;
      }> = [];
      const runner: CommandRunner = {
        run: async (command, args, options) => {
          calls.push({ command, args, options });
          return {
            exitCode: 0,
            stdout: args.includes("callsites")
              ? JSON.stringify({
                  ok: true,
                  callSites: [
                    { callSite: "mainAgent" },
                    { callSite: "summarizer" },
                  ],
                })
              : "",
            stderr: "",
          };
        },
        spawn: () => {
          throw new Error("stream not needed");
        },
      };
      class TestNuviAgent extends NuviAgent {
        credentialLoads = 0;

        protected override async extraJailConfig() {
          this.credentialLoads += 1;
          return {
            cloudflare: {
              accountId: "0".repeat(32),
              token: `secret-test-token-${this.credentialLoads}`,
              models: ["@cf/example/model", "@cf/example/aux"],
            },
            allowHosts: ["api.cloudflare.com"],
          };
        }
      }
      const runId = `eval-nuvi-test-${Date.now()}-abcd`;
      const dir = runArtifacts(runId).runDir;
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca");
      const agent = new TestNuviAgent({
        runId,
        testId: "timeline-recall",
        runner,
        processEnv: {
          EVALS_CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
          ...(localImages ? { EVALS_NUVI_LOCAL_IMAGE_TAG: "local-test" } : {}),
        },
        profile: {
          id: "nuvi-test",
          workspaceDir: "/tmp/unused",
          manifest: {
            species: "nuvi",
            cloudflare: {
              model: "@cf/example/model",
              auxiliaryModel: "@cf/example/aux",
            },
          },
        },
      });
      try {
        await agent.hatch();
        const hatch = calls.find(
          (call) => call.command === "nuvi" && call.args[0] === "hatch",
        );
        expect(hatch?.args[1]).toBe("nuvi");
        expect(hatch?.args).toContain("--disable-platform");
        expect(hatch?.args.includes("--source")).toBe(!localImages);
        expect(hatch?.options?.env?.NUVI_ASSISTANT_IMAGE).toBe(
          localImages ? "nuvi-local/evals-assistant:local-test" : undefined,
        );
        expect(hatch?.options?.env?.NUVI_LOCKFILE_DIR).toContain(
          "nuvi-eval-state-",
        );
        const jail = calls.find(
          (call) => call.command === "docker" && call.args[0] === "run",
        );
        expect(jail?.args).toContain("--tmpfs");
        const credentialWrite = calls.find((call) =>
          call.options?.stdin?.includes("secret-test-token"),
        );
        expect(credentialWrite?.command).toBe("docker");
        expect(credentialWrite?.args).toContain(`${runId}-egress-jail`);
        expect(agent.credentialLoads).toBe(2);
        const refreshIndex = calls.findIndex((call) =>
          call.options?.stdin?.includes("secret-test-token-2"),
        );
        expect(refreshIndex).toBeGreaterThan(calls.indexOf(hatch!));
        expect(refreshIndex).toBeLessThan(
          calls.findIndex(
            (call) => call.command === "nuvi" && call.args.includes("keys"),
          ),
        );
        expect(calls.find((call) => call.args.includes("keys"))?.args).toEqual([
          "exec",
          runId,
          "--",
          "assistant",
          "keys",
          "set",
          "openai-compatible",
          "eval-placeholder",
          "--generated",
        ]);
        expect(
          calls.find(
            (call) =>
              call.args.includes("providers") && call.args.includes("create"),
          )?.args,
        ).toContain("credential/openai-compatible/api_key");
        expect(
          calls.some((call) =>
            JSON.stringify(call.args).includes("secret-test-token"),
          ),
        ).toBe(false);
        expect(
          calls
            .filter((call) => call.command === "nuvi")
            .some((call) => JSON.stringify(call).includes("secret-test-token")),
        ).toBe(false);
        expect(
          calls.some(
            (call) =>
              call.args.includes("llm.callSites.summarizer.profile") &&
              call.args.includes("eval-auxiliary"),
          ),
        ).toBe(true);
        expect(
          calls.some((call) =>
            call.args.includes("llm.callSites.mainAgent.profile"),
          ),
        ).toBe(false);
        expect(
          calls.some(
            (call) =>
              call.args.includes("active") &&
              call.args.includes("eval-primary"),
          ),
        ).toBe(true);
      } finally {
        await agent.shutdown();
      }
    },
  );
});
