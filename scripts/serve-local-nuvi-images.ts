import { z } from "zod";
import { localNuviImages } from "../src/lib/adapters/nuvi-images";
import {
  assertSuccess,
  NodeCommandRunner,
  type CommandRunner,
} from "../src/lib/runtime/command-runner";

async function imageId(runner: CommandRunner, ref: string): Promise<string> {
  const result = await runner.run("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    ref,
  ]);
  assertSuccess(result, `inspect local image ${ref}`);
  const id = z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .safeParse(result.stdout.trim());
  if (!id.success) {
    throw new Error(`Invalid Docker image identity for ${ref}`);
  }
  return id.data;
}

export function localImageHandler(
  images: ReadonlyMap<string, string>,
  runner: CommandRunner,
) {
  return async (request: Request): Promise<Response> => {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/v1/images/load"
    ) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const body = z
      .object({ ref: z.string() })
      .safeParse(await request.json().catch(() => null));
    if (!body.success || !images.has(body.data.ref)) {
      return Response.json(
        { error: "Image is outside this eval" },
        { status: 403 },
      );
    }
    try {
      if (
        (await imageId(runner, body.data.ref)) !== images.get(body.data.ref)
      ) {
        return Response.json(
          { error: "Local image identity changed" },
          { status: 409 },
        );
      }
      return Response.json({ loaded: true, ref: body.data.ref });
    } catch {
      return Response.json(
        { error: "Pinned local image is unavailable" },
        { status: 503 },
      );
    }
  };
}

if (import.meta.main) {
  const selected = localNuviImages();
  if (selected.length === 0) {
    throw new Error(
      "Set EVALS_NUVI_LOCAL_IMAGE_TAG to a completed local build",
    );
  }
  const runner = new NodeCommandRunner();
  const pinned = new Map<string, string>();
  for (const image of selected) {
    pinned.set(image.ref, await imageId(runner, image.source));
  }
  for (const image of selected) {
    const result = await runner.run("docker", ["tag", image.source, image.ref]);
    assertSuccess(result, `alias local image ${image.source}`);
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 5500,
    maxRequestBodySize: 1024,
    fetch: localImageHandler(pinned, runner),
  });
  console.log(
    JSON.stringify({
      imageLoader: server.url.href,
      images: Object.fromEntries(pinned),
    }),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.stop(true);
      process.exit(0);
    });
  }
}
