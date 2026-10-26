import { describe, expect, test } from "bun:test";
import { localImageHandler } from "../../../scripts/serve-local-nuvi-images";
import { localNuviImages } from "../adapters/nuvi-images";
import type { CommandRunner } from "../runtime/command-runner";

const imageRef = "nuvi-local/evals-assistant:local-test";
const imageId = `sha256:${"a".repeat(64)}`;

function fakeRunner(stdout = imageId, exitCode = 0) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run: async (_command, args) => {
      calls.push(args);
      return { exitCode, stdout, stderr: "" };
    },
    spawn: () => {
      throw new Error("spawn not used");
    },
  };
  return { runner, calls };
}

function request(body: string) {
  return new Request("http://127.0.0.1:5500/v1/images/load", {
    method: "POST",
    body,
  });
}

describe("local Nuvi images", () => {
  test("opts in explicitly and maps all three services", () => {
    expect(localNuviImages({})).toEqual([]);
    expect(
      localNuviImages({ EVALS_NUVI_LOCAL_IMAGE_TAG: "local-test" }),
    ).toEqual([
      {
        variable: "NUVI_ASSISTANT_IMAGE",
        source: "nuvi-assistant:local-test",
        ref: imageRef,
      },
      {
        variable: "NUVI_GATEWAY_IMAGE",
        source: "nuvi-gateway:local-test",
        ref: "nuvi-local/evals-gateway:local-test",
      },
      {
        variable: "NUVI_CREDENTIAL_EXECUTOR_IMAGE",
        source: "nuvi-credential-executor:local-test",
        ref: "nuvi-local/evals-credential-executor:local-test",
      },
    ]);
  });

  test.each(["../other", "tag with spaces", "-option", "x".repeat(129)])(
    "rejects invalid tag %s",
    (tag) => {
      expect(() =>
        localNuviImages({ EVALS_NUVI_LOCAL_IMAGE_TAG: tag }),
      ).toThrow("Docker image tag");
    },
  );

  test("confirms the pinned identity without pulling or building", async () => {
    const { runner, calls } = fakeRunner();
    const response = await localImageHandler(
      new Map([[imageRef, imageId]]),
      runner,
    )(request(JSON.stringify({ ref: imageRef })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ loaded: true, ref: imageRef });
    expect(calls).toEqual([
      ["image", "inspect", "--format", "{{.Id}}", imageRef],
    ]);
  });

  test.each(["invalid", "null", '{"ref":"unrelated:latest"}'])(
    "rejects unapproved payload %s without invoking Docker",
    async (body) => {
      const { runner, calls } = fakeRunner();
      const response = await localImageHandler(
        new Map([[imageRef, imageId]]),
        runner,
      )(request(body));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    },
  );

  test("rejects a retagged image", async () => {
    const { runner } = fakeRunner(`sha256:${"b".repeat(64)}`);
    const response = await localImageHandler(
      new Map([[imageRef, imageId]]),
      runner,
    )(request(JSON.stringify({ ref: imageRef })));
    expect(response.status).toBe(409);
  });

  test("rejects a missing image", async () => {
    const { runner } = fakeRunner("", 1);
    const response = await localImageHandler(
      new Map([[imageRef, imageId]]),
      runner,
    )(request(JSON.stringify({ ref: imageRef })));
    expect(response.status).toBe(503);
  });
});
