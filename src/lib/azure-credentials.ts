import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
type KeyReader = (
  resourceGroup: string,
  resourceName: string,
) => Promise<string>;

const readResourceKeys: KeyReader = async (resourceGroup, resourceName) => {
  const { stdout } = await execute(
    "az",
    [
      "cognitiveservices",
      "account",
      "keys",
      "list",
      "--resource-group",
      resourceGroup,
      "--name",
      resourceName,
      "--output",
      "json",
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 65_536, windowsHide: true },
  );
  return stdout;
};

/** Loads the selected Azure resource key into this process, never a file. */
export async function prepareAzureCredentials(
  env: NodeJS.ProcessEnv = process.env,
  readKeys: KeyReader = readResourceKeys,
): Promise<"azure-cli" | "environment" | "not-applicable"> {
  if (env.EVALS_LLM_PROVIDER !== "azure") {
    return "not-applicable";
  }
  const group = env.EVALS_AZURE_RESOURCE_GROUP?.trim();
  const name = env.EVALS_AZURE_RESOURCE_NAME?.trim();
  if (!group && !name) {
    return "environment";
  }
  if (!group || !name) {
    throw new Error(
      "Set both EVALS_AZURE_RESOURCE_GROUP and EVALS_AZURE_RESOURCE_NAME",
    );
  }
  const endpoint = z
    .url({ protocol: /^https$/ })
    .safeParse(env.AZURE_OPENAI_ENDPOINT);
  if (!endpoint.success) {
    throw new Error("AZURE_OPENAI_ENDPOINT must be an HTTPS resource URL");
  }
  const url = new URL(endpoint.data);
  const hosts = [
    "openai.azure.com",
    "services.ai.azure.com",
    "cognitiveservices.azure.com",
  ].map((suffix) => `${name.toLowerCase()}.${suffix}`);
  if (
    !hosts.includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Azure credential resource does not match AZURE_OPENAI_ENDPOINT",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readKeys(group, name));
  } catch {
    throw new Error(
      "Could not load Azure eval credentials. Check az login and resource-key permissions.",
    );
  }
  const keys = z.object({ key1: z.string().regex(/^\S+$/) }).safeParse(raw);
  if (!keys.success) {
    throw new Error("Azure CLI returned an invalid resource-key response");
  }
  env.AZURE_OPENAI_API_KEY = keys.data.key1;
  return "azure-cli";
}
