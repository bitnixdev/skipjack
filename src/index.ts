import * as core from "@actions/core";
import { run } from "./main.js";

run({
  core,
  fetch: globalThis.fetch,
  repository: process.env.GITHUB_REPOSITORY,
}).catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error : String(error));
});
