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

describe("run", () => {
  it("exchanges an OIDC token, masks secrets, and exports returned values", async () => {
    const { core, events } = createCore({
      url: "https://skipjack.example.com/",
      org: "acme",
      project: "shared-ci",
    });
    const fetch = vi.fn<Fetch>(async () =>
      Response.json({
        secrets: { TOKEN: "secret", SHARED: "secret-wins" },
        variables: { REGION: "us-west-2", SHARED: "variable-loses" },
        grantedBy: ["policy-1"],
      }),
    );

    await run({ core, fetch });

    expect(core.getIDToken).toHaveBeenCalledWith("https://skipjack.example.com");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("https://skipjack.example.com/oidc/secrets");
    expect(request).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      token: "oidc-token",
      org: "acme",
      project: "shared-ci",
    });
    expect(events).toEqual([
      "mask:secret",
      "mask:secret-wins",
      "env:REGION:us-west-2",
      "env:SHARED:variable-loses",
      "env:TOKEN:secret",
      "env:SHARED:secret-wins",
    ]);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("defaults URL, organization, and project from the GitHub repository", async () => {
    const { core } = createCore({});
    const fetch = vi.fn<Fetch>(async () =>
      Response.json({ secrets: {}, variables: {}, grantedBy: [] }),
    );

    await run({ core, fetch, repository: "BitnixDev/Skipjack" });

    expect(core.getIDToken).toHaveBeenCalledWith(
      "https://skipjack.bitnix.dev",
    );
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("https://skipjack.bitnix.dev/oidc/secrets");
    expect(JSON.parse(String(request?.body))).toEqual({
      token: "oidc-token",
      org: "bitnixdev",
      project: "skipjack",
    });
  });

  it("supports explicit scope and audience overrides", async () => {
    const { core, events } = createCore({
      url: "https://skipjack.example.com/base",
      org: "acme",
      project: "shared-ci",
      audience: "skipjack-production",
    });
    const fetch = vi.fn<Fetch>(async () =>
      Response.json({ secrets: {}, variables: {}, grantedBy: [] }),
    );

    await run({ core, fetch });

    expect(core.getIDToken).toHaveBeenCalledWith("skipjack-production");
    const [, request] = fetch.mock.calls[0];
    expect(JSON.parse(String(request?.body))).toEqual({
      token: "oidc-token",
      org: "acme",
      project: "shared-ci",
    });
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

  it("reports structured server errors without exporting values", async () => {
    const { core, events } = createCore({
      url: "https://skipjack.example.com",
      org: "acme",
      project: "shared-ci",
    });
    const fetch = vi.fn<Fetch>(async () =>
      Response.json(
        { error: "no_policy_matched", detail: "repo:acme/example" },
        { status: 403 },
      ),
    );

    await run({ core, fetch });

    expect(core.setFailed).toHaveBeenCalledWith(
      "Skipjack rejected the exchange (HTTP 403, no_policy_matched): repo:acme/example",
    );
    expect(events).toEqual([]);
  });

  it("rejects malformed successful responses", async () => {
    const { core, events } = createCore({
      url: "https://skipjack.example.com",
      org: "acme",
      project: "shared-ci",
    });
    const fetch = vi.fn<Fetch>(async () =>
      Response.json({ secrets: { TOKEN: 123 } }),
    );

    await run({ core, fetch });

    expect(core.setFailed).toHaveBeenCalledWith(
      "Skipjack returned an invalid exchange response",
    );
    expect(events).toEqual([]);
  });

  it("rejects response keys that cannot safely be exported", async () => {
    const { core, events } = createCore({
      url: "https://skipjack.example.com",
      org: "acme",
      project: "shared-ci",
    });
    const fetch = vi.fn<Fetch>(async () =>
      Response.json({
        secrets: {},
        variables: { "BAD\nNAME": "injected" },
        grantedBy: [],
      }),
    );

    await run({ core, fetch });

    expect(core.setFailed).toHaveBeenCalledWith(
      "Skipjack returned an invalid exchange response",
    );
    expect(events).toEqual([]);
  });
});
