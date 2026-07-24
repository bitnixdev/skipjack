import { describe, expect, it, vi } from "vitest";
import { run, type ActionsCore } from "../src/main.js";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function createCore(inputs: Record<string, string>) {
  const events: string[] = [];
  const core: ActionsCore = {
    getInput: vi.fn((name: string) => inputs[name] ?? ""),
    getIDToken: vi.fn(async () => "oidc-token"),
    setFailed: vi.fn(),
    setSecret: vi.fn((value: string) => events.push(`mask:${value}`)),
    exportVariable: vi.fn((name: string, value: string) =>
      events.push(`env:${name}:${value}`),
    ),
    info: vi.fn(),
  };
  return { core, events };
}

function resourceUrls(
  base: string,
  org: string,
  project: string,
): [string, string, string, string] {
  const orgBase = `${base}/v1/orgs/${org}`;
  const projectBase = `${orgBase}/projects/${project}`;
  return [
    `${orgBase}/secrets`,
    `${orgBase}/variables`,
    `${projectBase}/secrets`,
    `${projectBase}/variables`,
  ];
}

function emptyResourceFetch(base: string, org: string, project: string) {
  const [orgSecrets, orgVariables, projectSecrets, projectVariables] =
    resourceUrls(base, org, project);
  const responses = new Map<string, unknown>([
    [orgSecrets, { secrets: [] }],
    [orgVariables, { variables: [] }],
    [projectSecrets, { secrets: [] }],
    [projectVariables, { variables: [] }],
  ]);
  return vi.fn<Fetch>(async (input) => {
    const body = responses.get(String(input));
    return body === undefined
      ? Response.json({ error: "not_found" }, { status: 404 })
      : Response.json(body);
  });
}

describe("run", () => {
  it("reads org and project resources, merges project values, masks secrets, and exports values", async () => {
    const { core, events } = createCore({
      url: "https://skipjack.example.com/",
      org: "acme",
      project: "shared-ci",
    });
    const [orgSecrets, orgVariables, projectSecrets, projectVariables] =
      resourceUrls("https://skipjack.example.com", "acme", "shared-ci");
    const responses = new Map<string, unknown>([
      [
        orgSecrets,
        {
          secrets: [
            { name: "ORG_TOKEN", value: "org-secret", version: 1 },
            { name: "SHARED", value: "org-loses", version: 1 },
          ],
        },
      ],
      [
        orgVariables,
        {
          variables: [
            { name: "REGION", value: "us-east-1" },
            { name: "SHARED", value: "variable-loses" },
          ],
        },
      ],
      [
        projectSecrets,
        {
          secrets: [
            { name: "TOKEN", value: "project-secret", version: 2 },
            { name: "SHARED", value: "project-wins", version: 3 },
          ],
        },
      ],
      [
        projectVariables,
        { variables: [{ name: "REGION", value: "us-west-2" }] },
      ],
    ]);
    const fetch = vi.fn<Fetch>(async (input) =>
      Response.json(responses.get(String(input))),
    );

    await run({
      core,
      fetch,
      repository: "acme/shared-ci",
      ref: "refs/heads/main",
      workflow: "deploy",
      job: "deploy",
      runId: "123",
      runAttempt: "1",
      eventName: "push",
    });

    expect(core.getIDToken).toHaveBeenCalledWith("https://skipjack.example.com");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      orgSecrets,
      orgVariables,
      projectSecrets,
      projectVariables,
    ]);
    for (const [, request] of fetch.mock.calls) {
      expect(request).toMatchObject({
        method: "GET",
        headers: {
          authorization: "Bearer oidc-token",
          accept: "application/json",
        },
      });
    }
    expect(events).toEqual([
      "mask:org-secret",
      "mask:project-wins",
      "mask:project-secret",
      "env:REGION:us-west-2",
      "env:SHARED:variable-loses",
      "env:ORG_TOKEN:org-secret",
      "env:SHARED:project-wins",
      "env:TOKEN:project-secret",
    ]);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "scope=acme/shared-ci; audience=https://skipjack.example.com",
      ),
    );
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "repository=acme/shared-ci; ref=refs/heads/main; workflow=deploy",
      ),
    );
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("Skipjack API response: HTTP 200"),
    );
    const logs = vi
      .mocked(core.info)
      .mock.calls.flat()
      .map(String)
      .join("\n");
    expect(logs).toContain("ORG_TOKEN");
    expect(logs).toContain("TOKEN");
    expect(logs).toContain("REGION");
    expect(logs).not.toContain("oidc-token");
    expect(logs).not.toContain("project-wins");
    expect(logs).not.toContain("us-west-2");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("defaults URL, organization, and project from the GitHub repository", async () => {
    const { core } = createCore({});
    const fetch = emptyResourceFetch(
      "https://skipjack.bitnix.dev",
      "bitnixdev",
      "skipjack",
    );

    await run({ core, fetch, repository: "BitnixDev/Skipjack" });

    expect(core.getIDToken).toHaveBeenCalledWith(
      "https://skipjack.bitnix.dev",
    );
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(
      resourceUrls(
        "https://skipjack.bitnix.dev",
        "bitnixdev",
        "skipjack",
      ),
    );
  });

  it("supports explicit scope and audience overrides", async () => {
    const { core, events } = createCore({
      url: "https://skipjack.example.com/base",
      org: "acme",
      project: "shared-ci",
      audience: "skipjack-production",
    });
    const fetch = emptyResourceFetch(
      "https://skipjack.example.com/base",
      "acme",
      "shared-ci",
    );

    await run({ core, fetch });

    expect(core.getIDToken).toHaveBeenCalledWith("skipjack-production");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(events).toEqual([]);
  });

  it("rejects plaintext HTTP before requesting an OIDC token", async () => {
    const { core } = createCore({
      url: "http://localhost:8787",
      org: "acme",
      project: "shared-ci",
    });
    const fetch = vi.fn<Fetch>();

    await expect(run({ core, fetch })).rejects.toThrow(
      'The "url" input must use https',
    );
    expect(core.getIDToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains how to enable OIDC when token acquisition fails", async () => {
    const { core } = createCore({
      url: "https://skipjack.example.com",
      org: "acme",
      project: "shared-ci",
    });
    vi.mocked(core.getIDToken).mockRejectedValue(new Error("permission denied"));
    const fetch = vi.fn<Fetch>();

    await run({ core, fetch });

    expect(fetch).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("permissions: id-token: write"),
    );
  });

  it("reports structured API errors without exporting values", async () => {
    const { core, events } = createCore({
      url: "https://skipjack.example.com",
      org: "acme",
      project: "shared-ci",
    });
    const [failedUrl] = resourceUrls(
      "https://skipjack.example.com",
      "acme",
      "shared-ci",
    );
    const fetch = vi.fn<Fetch>(async (input) =>
      String(input) === failedUrl
        ? Response.json(
            { error: "forbidden", detail: "secrets:r is required" },
            {
              status: 403,
              headers: { "x-request-id": "request-123" },
            },
          )
        : Response.json(
            String(input).endsWith("/secrets")
              ? { secrets: [] }
              : { variables: [] },
          ),
    );

    await run({ core, fetch });

    expect(core.setFailed).toHaveBeenCalledWith(
      "Skipjack API request failed (HTTP 403, forbidden): " +
        "secrets:r is required; scope=acme; " +
        "endpoint=GET https://skipjack.example.com/v1/orgs/acme/secrets; " +
        "request-id=request-123",
    );
    expect(events).toEqual([]);
  });

  it("rejects malformed successful responses", async () => {
    const { core, events } = createCore({
      url: "https://skipjack.example.com",
      org: "acme",
      project: "shared-ci",
    });
    const fetch = vi.fn<Fetch>(async (input) =>
      Response.json(
        String(input).endsWith("/secrets")
          ? { secrets: { TOKEN: "not-an-array" } }
          : { variables: [] },
      ),
    );

    await run({ core, fetch });

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("invalid secrets response"),
    );
    expect(events).toEqual([]);
  });

  it("rejects response keys that cannot safely be exported", async () => {
    const { core, events } = createCore({
      url: "https://skipjack.example.com",
      org: "acme",
      project: "shared-ci",
    });
    const fetch = vi.fn<Fetch>(async (input) =>
      Response.json(
        String(input).endsWith("/secrets")
          ? { secrets: [] }
          : { variables: [{ name: "BAD\nNAME", value: "injected" }] },
      ),
    );

    await run({ core, fetch });

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("invalid variables response"),
    );
    expect(events).toEqual([]);
  });
});
