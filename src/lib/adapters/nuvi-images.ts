import { z } from "zod";

export function localNuviImages(env: NodeJS.ProcessEnv = process.env) {
  const value = env.EVALS_NUVI_LOCAL_IMAGE_TAG;
  if (!value) {
    return [];
  }
  const tag = z
    .string()
    .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/)
    .safeParse(value);
  if (!tag.success) {
    throw new Error("EVALS_NUVI_LOCAL_IMAGE_TAG must be a Docker image tag");
  }
  return (
    [
      ["assistant", "NUVI_ASSISTANT_IMAGE"],
      ["gateway", "NUVI_GATEWAY_IMAGE"],
      ["credential-executor", "NUVI_CREDENTIAL_EXECUTOR_IMAGE"],
    ] as const
  ).map(([service, variable]) => ({
    variable,
    source: `nuvi-${service}:${tag.data}`,
    ref: `nuvi-local/evals-${service}:${tag.data}`,
  }));
}
