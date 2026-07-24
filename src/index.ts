import * as core from "@actions/core";
import { run } from "./main.js";

run({
  core,
  fetch: globalThis.fetch,
  repository: process.env.GITHUB_REPOSITORY,
  ref: process.env.GITHUB_REF,
  workflow: process.env.GITHUB_WORKFLOW,
  job: process.env.GITHUB_JOB,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  eventName: process.env.GITHUB_EVENT_NAME,
}).catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error : String(error));
});
