import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);

export interface CloudflareCredentials {
  accountId: string;
  token: string;
  models: string[];
}

export async function loadCloudflareCredentials(
  models: string[],
  env: NodeJS.ProcessEnv = process.env,
  readToken: (command: string) => Promise<string> = async (command) => {
    const { stdout } = await execute(command, ["auth", "token", "--json"], {
      timeout: 30_000,
      maxBuffer: 65_536,
      windowsHide: true,
    });
    return stdout;
  },
): Promise<CloudflareCredentials> {
  const accountId = z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .safeParse(env.EVALS_CLOUDFLARE_ACCOUNT_ID);
  if (!accountId.success) {
    throw new Error(
      "EVALS_CLOUDFLARE_ACCOUNT_ID must be a Cloudflare account ID",
    );
  }
  const allowedModels = z
    .array(z.string().regex(/^@cf\/[a-z0-9./_-]+$/))
    .min(1)
    .safeParse(models);
  if (!allowedModels.success) {
    throw new Error("Nuvi evals require explicit Cloudflare model IDs");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readToken(env.EVALS_WRANGLER_CLI || "wrangler"));
  } catch {
    throw new Error(
      "Could not load Cloudflare eval credentials. Check Wrangler login.",
    );
  }
  const credential = z
    .object({ type: z.string(), token: z.string().regex(/^\S+$/) })
    .safeParse(raw);
  if (!credential.success) {
    throw new Error("Wrangler returned an invalid authentication response");
  }
  return {
    accountId: accountId.data,
    token: credential.data.token,
    models: [...new Set(allowedModels.data)],
  };
}
