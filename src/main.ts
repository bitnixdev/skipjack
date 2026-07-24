export interface ActionsCore {
  getInput(name: string, options?: { required?: boolean }): string;
  getIDToken(audience?: string): Promise<string>;
  setFailed(message: string | Error): void;
  setSecret(secret: string): void;
  exportVariable(name: string, value: string): void;
  info(message: string): void;
}

interface ExchangeResponse {
  secrets: Record<string, string>;
  variables?: Record<string, string>;
  grantedBy: string[];
}

interface ExchangeError {
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

function isEnvironmentRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([name, entry]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof entry === "string",
    )
  );
}

function isExchangeResponse(value: unknown): value is ExchangeResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const response = value as Partial<ExchangeResponse>;
  return (
    isEnvironmentRecord(response.secrets) &&
    (response.variables === undefined ||
      isEnvironmentRecord(response.variables)) &&
    Array.isArray(response.grantedBy) &&
    response.grantedBy.every((entry) => typeof entry === "string")
  );
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

function formatExchangeError(
  response: Response,
  value: unknown,
  endpoint: string,
  scope: string,
): string {
  const error =
    typeof value === "object" && value !== null
      ? (value as ExchangeError)
      : undefined;
  const code = typeof error?.error === "string" ? error.error : "unknown_error";
  const detail = typeof error?.detail === "string" ? `: ${error.detail}` : "";
  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("cf-ray") ??
    response.headers.get("traceparent") ??
    "unavailable";
  return (
    `Skipjack rejected the exchange (HTTP ${response.status}, ${code})` +
    `${detail}; scope=${scope}; endpoint=POST ${endpoint}; ` +
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
  const endpoint = `${url}/oidc/secrets`;
  const scope = `${org}/${project}`;

  core.info(
    `Requesting Skipjack exchange: endpoint=POST ${endpoint}; ` +
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

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      token: idToken,
      org,
      project,
    }),
  });

  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("cf-ray") ??
    response.headers.get("traceparent") ??
    "unavailable";
  core.info(
    `Skipjack exchange response: HTTP ${response.status}; ` +
      `content-type=${response.headers.get("content-type") ?? "unset"}; ` +
      `request-id=${requestId}`,
  );

  const payload = await readJson(response);
  if (!response.ok) {
    core.setFailed(formatExchangeError(response, payload, endpoint, scope));
    return;
  }
  if (!isExchangeResponse(payload)) {
    core.setFailed("Skipjack returned an invalid exchange response");
    return;
  }

  const variables = payload.variables ?? {};

  // Register every secret with the runner before exporting any returned value.
  for (const value of Object.values(payload.secrets)) core.setSecret(value);

  // A same-named secret intentionally wins over a non-secret variable.
  for (const [name, value] of Object.entries(variables)) {
    core.exportVariable(name, value);
  }
  for (const [name, value] of Object.entries(payload.secrets)) {
    core.exportVariable(name, value);
  }

  const names = [
    ...new Set([...Object.keys(payload.secrets), ...Object.keys(variables)]),
  ];
  const suffix = names.length > 0 ? `: ${names.join(", ")}` : "";
  core.info(
    `Retrieved ${Object.keys(payload.secrets).length} secret(s) and ` +
      `${Object.keys(variables).length} variable(s) from ${scope}${suffix}`,
  );
}
