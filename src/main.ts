export interface ActionsCore {
  getInput(name: string, options?: { required?: boolean }): string;
  getIDToken(audience?: string): Promise<string>;
  setFailed(message: string | Error): void;
  setSecret(secret: string): void;
  exportVariable(name: string, value: string): void;
  info(message: string): void;
}

interface NamedValue {
  name: string;
  value: string;
}

interface ApiError {
  error?: string;
  detail?: string;
}

export interface RunDependencies {
  core: ActionsCore;
  fetch: typeof globalThis.fetch;
  repository?: string;
  ref?: string;
  workflow?: string;
  job?: string;
  runId?: string;
  runAttempt?: string;
  eventName?: string;
}

const DEFAULT_URL = "https://skipjack.bitnix.dev";

function repositoryScope(repository: string | undefined): {
  org: string;
  project: string;
} {
  const [owner, name, ...extra] = repository?.split("/") ?? [];
  if (!owner || !name || extra.length > 0) {
    throw new Error(
      "Could not derive the Skipjack organization and project from " +
        "GITHUB_REPOSITORY; set the `org` and `project` inputs explicitly",
    );
  }

  return { org: owner.toLowerCase(), project: name.toLowerCase() };
}

function normalizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The "url" input must be a valid absolute URL');
  }

  if (url.protocol !== "https:") {
    throw new Error('The "url" input must use https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'The "url" input must not contain credentials, a query, or a fragment',
    );
  }

  return url.toString().replace(/\/+$/, "");
}

function isNamedValue(value: unknown): value is NamedValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Partial<NamedValue>).name === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test((value as NamedValue).name) &&
    typeof (value as Partial<NamedValue>).value === "string"
  );
}

function readNamedValues(value: unknown, key: "secrets" | "variables"): NamedValue[] | null {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>)[key]) &&
    (value as Record<string, unknown[]>)[key].every(isNamedValue)
  )
    ? ((value as Record<string, NamedValue[]>)[key])
    : null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function formatApiError(
  response: Response,
  value: unknown,
  endpoint: string,
  scope: string,
): string {
  const error =
    typeof value === "object" && value !== null
      ? (value as ApiError)
      : undefined;
  const code = typeof error?.error === "string" ? error.error : "unknown_error";
  const detail = typeof error?.detail === "string" ? `: ${error.detail}` : "";
  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("cf-ray") ??
    response.headers.get("traceparent") ??
    "unavailable";
  return (
    `Skipjack API request failed (HTTP ${response.status}, ${code})` +
    `${detail}; scope=${scope}; endpoint=GET ${endpoint}; ` +
    `request-id=${requestId}`
  );
}

export async function run({
  core,
  fetch,
  repository,
  ref,
  workflow,
  job,
  runId,
  runAttempt,
  eventName,
}: RunDependencies): Promise<void> {
  const url = normalizeUrl(core.getInput("url") || DEFAULT_URL);
  const configuredOrg = core.getInput("org");
  const configuredProject = core.getInput("project");
  const defaults =
    configuredOrg && configuredProject
      ? undefined
      : repositoryScope(repository);
  const org = configuredOrg || defaults!.org;
  const project = configuredProject || defaults!.project;
  const audience = core.getInput("audience") || url;
  const scope = `${org}/${project}`;
  const orgBase = `${url}/v1/orgs/${encodeURIComponent(org)}`;
  const projectBase =
    `${orgBase}/projects/${encodeURIComponent(project)}`;
  const requests = [
    { endpoint: `${orgBase}/secrets`, key: "secrets" as const, scope: org },
    { endpoint: `${orgBase}/variables`, key: "variables" as const, scope: org },
    {
      endpoint: `${projectBase}/secrets`,
      key: "secrets" as const,
      scope,
    },
    {
      endpoint: `${projectBase}/variables`,
      key: "variables" as const,
      scope,
    },
  ];

  core.info(
    `Requesting Skipjack resources from the /v1 workload identity API: ` +
      `scope=${scope}; audience=${audience}; ` +
      `repository=${repository ?? "unset"}; ref=${ref ?? "unset"}; ` +
      `workflow=${workflow ?? "unset"}; job=${job ?? "unset"}; ` +
      `run=${runId ?? "unset"}; attempt=${runAttempt ?? "unset"}; ` +
      `event=${eventName ?? "unset"}`,
  );

  let idToken: string;
  try {
    idToken = await core.getIDToken(audience);
  } catch (error) {
    core.setFailed(
      "Could not get an OIDC token from the runner. Ensure the job has " +
        "`permissions: id-token: write`. " +
        `Underlying error: ${String(error)}`,
    );
    return;
  }

  const results = await Promise.all(
    requests.map(async (request) => {
      const response = await fetch(request.endpoint, {
        method: "GET",
        headers: {
          authorization: `Bearer ${idToken}`,
          accept: "application/json",
        },
      });
      const requestId =
        response.headers.get("x-request-id") ??
        response.headers.get("cf-ray") ??
        response.headers.get("traceparent") ??
        "unavailable";
      core.info(
        `Skipjack API response: HTTP ${response.status}; ` +
          `endpoint=GET ${request.endpoint}; ` +
          `content-type=${response.headers.get("content-type") ?? "unset"}; ` +
          `request-id=${requestId}`,
      );
      return { ...request, response, payload: await readJson(response) };
    }),
  );

  for (const result of results) {
    if (!result.response.ok) {
      core.setFailed(
        formatApiError(
          result.response,
          result.payload,
          result.endpoint,
          result.scope,
        ),
      );
      return;
    }
  }

  const parsed = results.map((result) => ({
    ...result,
    values: readNamedValues(result.payload, result.key),
  }));
  const invalid = parsed.find((result) => result.values === null);
  if (invalid) {
    core.setFailed(
      `Skipjack returned an invalid ${invalid.key} response; ` +
        `endpoint=GET ${invalid.endpoint}`,
    );
    return;
  }

  const orgSecrets = parsed[0].values!;
  const orgVariables = parsed[1].values!;
  const projectSecrets = parsed[2].values!;
  const projectVariables = parsed[3].values!;
  const secrets: Record<string, string> = {};
  const variables: Record<string, string> = {};

  // Organization values form the base; project values intentionally win.
  for (const entry of [...orgSecrets, ...projectSecrets]) {
    secrets[entry.name] = entry.value;
  }
  for (const entry of [...orgVariables, ...projectVariables]) {
    variables[entry.name] = entry.value;
  }

  // Register every secret with the runner before exporting any returned value.
  for (const value of Object.values(secrets)) core.setSecret(value);

  // A same-named secret intentionally wins over a non-secret variable.
  for (const [name, value] of Object.entries(variables)) {
    core.exportVariable(name, value);
  }
  for (const [name, value] of Object.entries(secrets)) {
    core.exportVariable(name, value);
  }

  const names = [
    ...new Set([...Object.keys(secrets), ...Object.keys(variables)]),
  ];
  const suffix = names.length > 0 ? `: ${names.join(", ")}` : "";
  core.info(
    `Retrieved ${Object.keys(secrets).length} secret(s) and ` +
      `${Object.keys(variables).length} variable(s) from ${scope}${suffix}`,
  );
}
