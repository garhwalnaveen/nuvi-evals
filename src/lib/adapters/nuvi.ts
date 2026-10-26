import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { AgentHatchInput } from "../adapter";
import { loadCloudflareCredentials } from "../cloudflare-credentials";
import {
  DEFAULT_EMBEDDING_ALLOW_HOSTS,
  stageCloudflareCredentials,
  type DockerEgressJailConfig,
} from "../egress/docker-jail";
import {
  assertSuccess,
  NodeCommandRunner,
  type CommandRunner,
} from "../runtime/command-runner";
import { VellumAgent, type VellumAgentOptions } from "./vellum";
import { localNuviImages } from "./nuvi-images";

export const NUVI_RUNTIME_ALLOW_HOSTS = [
  "api.cloudflare.com",
  ...DEFAULT_EMBEDDING_ALLOW_HOSTS,
  "github.com",
  "release-assets.githubusercontent.com",
];

export function isolatedNuviRunner(
  runner: CommandRunner,
  cli: string,
  stateDir: string,
  imageEnv: Record<string, string> = {},
): CommandRunner {
  const env = {
    ...imageEnv,
    NUVI_ENVIRONMENT: "local",
    NUVI_LOCKFILE_DIR: join(stateDir, "config"),
    XDG_CONFIG_HOME: join(stateDir, "config"),
    XDG_DATA_HOME: join(stateDir, "data"),
    XDG_STATE_HOME: join(stateDir, "state"),
  };
  return {
    run: (command, args, options) =>
      runner.run(
        command,
        args,
        command === cli
          ? { ...options, env: { ...options?.env, ...env } }
          : options,
      ),
    spawn: (command, args, options) =>
      runner.spawn(
        command,
        args,
        command === cli
          ? { ...options, env: { ...options?.env, ...env } }
          : options,
      ),
  };
}

export class NuviAgent extends VellumAgent {
  private readonly stateDir: string;

  protected override get species(): "nuvi" {
    return "nuvi";
  }

  constructor(options: VellumAgentOptions) {
    if (!options.profile.manifest.cloudflare) {
      throw new Error("Nuvi eval profiles must declare Cloudflare models");
    }
    const images = localNuviImages(options.processEnv ?? process.env);
    const stateDir = mkdtempSync(join(tmpdir(), "nuvi-eval-state-"));
    const cliCommand = options.cliCommand ?? "nuvi";
    super({
      ...options,
      cliCommand,
      runner: isolatedNuviRunner(
        options.runner ?? new NodeCommandRunner(),
        cliCommand,
        stateDir,
        Object.fromEntries(images.map((image) => [image.variable, image.ref])),
      ),
    });
    this.stateDir = stateDir;
  }

  protected override async extraJailConfig(): Promise<
    Required<Pick<DockerEgressJailConfig, "cloudflare" | "allowHosts">>
  > {
    const config = this.profile.manifest.cloudflare;
    if (!config) {
      throw new Error("Missing Nuvi model configuration");
    }
    const cloudflare = await loadCloudflareCredentials(
      [config.model, config.auxiliaryModel],
      this.processEnv,
    );
    return {
      cloudflare,
      allowHosts: NUVI_RUNTIME_ALLOW_HOSTS,
    };
  }

  protected override extraHatchArgs(): string[] {
    return ["--disable-platform"];
  }

  protected override sourceHatchArgs(source: string): string[] {
    return localNuviImages(this.processEnv).length > 0
      ? []
      : super.sourceHatchArgs(source);
  }

  private async assistantCommand(args: string[]): Promise<string> {
    const result = await this.runner.run(this.cliCommand, [
      "exec",
      this.id,
      "--",
      "assistant",
      ...args,
    ]);
    assertSuccess(result, `configure Nuvi eval: ${args[0]}`);
    return result.stdout;
  }

  protected override async configureRuntime(): Promise<void> {
    const config = this.profile.manifest.cloudflare;
    if (!config) {
      throw new Error("Missing Nuvi model configuration");
    }
    const { cloudflare } = await this.extraJailConfig();
    await stageCloudflareCredentials(this.runner, this.id, cloudflare);
    const account = this.processEnv.EVALS_CLOUDFLARE_ACCOUNT_ID;
    await this.assistantCommand([
      "keys",
      "set",
      "openai-compatible",
      "eval-placeholder",
      "--generated",
    ]);
    await this.assistantCommand([
      "inference",
      "providers",
      "create",
      "cloudflare-eval",
      "--provider",
      "openai-compatible",
      "--credential",
      "credential/openai-compatible/api_key",
      "--base-url",
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`,
      ...[...new Set([config.model, config.auxiliaryModel])].flatMap(
        (model) => ["--model", model],
      ),
    ]);
    for (const [name, model] of [
      ["eval-primary", config.model],
      ["eval-auxiliary", config.auxiliaryModel],
    ]) {
      await this.assistantCommand([
        "inference",
        "profiles",
        "create",
        name,
        "--provider",
        "openai-compatible",
        "--connection",
        "cloudflare-eval",
        "--model",
        model,
        "--effort",
        "medium",
        "--max-tokens",
        "16384",
        "--allow-unlisted",
      ]);
    }
    const sites = z
      .object({
        ok: z.literal(true),
        callSites: z.array(
          z.object({ callSite: z.string().regex(/^[A-Za-z0-9]+$/) }),
        ),
      })
      .safeParse(
        JSON.parse(
          await this.assistantCommand([
            "inference",
            "callsites",
            "list",
            "--json",
          ]),
        ),
      );
    if (!sites.success) {
      throw new Error("Nuvi returned an invalid call-site catalog");
    }
    for (const { callSite } of sites.data.callSites) {
      if (callSite !== "mainAgent") {
        await this.assistantCommand([
          "config",
          "set",
          `llm.callSites.${callSite}.profile`,
          "eval-auxiliary",
        ]);
      }
    }
    await this.assistantCommand([
      "inference",
      "profiles",
      "active",
      "eval-primary",
    ]);
  }

  override async hatch(): Promise<void> {
    try {
      await super.hatch();
    } catch (error) {
      await rm(this.stateDir, { recursive: true, force: true });
      throw error;
    }
  }

  override async shutdown(): Promise<void> {
    try {
      await super.shutdown();
    } finally {
      await rm(this.stateDir, { recursive: true, force: true });
    }
  }
}

export function createNuviAgent(input: AgentHatchInput): NuviAgent {
  return new NuviAgent({
    ...input,
    cliCommand: process.env.EVALS_NUVI_CLI?.trim() || "nuvi",
  });
}
