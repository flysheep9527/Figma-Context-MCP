import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FigmaService, type FigmaAuthOptions } from "~/services/figma.js";
import { getFigmaData } from "~/services/get-figma-data.js";

const figmaFileResponse = {
  name: "Auth Test File",
  lastModified: "2026-01-01T00:00:00Z",
  thumbnailUrl: "",
  version: "1",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "1:1",
        name: "Page",
        type: "CANVAS",
        visible: true,
        children: [],
      },
    ],
  },
  components: {},
  componentSets: {},
  schemaVersion: 0,
  styles: {},
};

function makePatAuth(tokens: string[]): FigmaAuthOptions {
  return {
    figmaApiKey: tokens[0] ?? "",
    figmaApiKeys: tokens,
    figmaOAuthToken: "",
    useOAuth: false,
  };
}

describe("FigmaService PAT rotation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rotates to the next PAT when the current one hits 429", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://api.figma.com/v1/files/abc123")) {
        throw new Error(`unexpected URL: ${url}`);
      }

      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["X-Figma-Token"] === "token-a") {
        return new Response(JSON.stringify({ error: "rate limit" }), {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }

      return Response.json(figmaFileResponse);
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new FigmaService(makePatAuth(["token-a", "token-b"]));
    const result = await service.getRawFile("abc123");

    expect(result.data.name).toBe("Auth Test File");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["X-Figma-Token"]).toBe(
      "token-a",
    );
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>)["X-Figma-Token"]).toBe(
      "token-b",
    );
  });

  it("fails once all PATs are rate limited", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://api.figma.com/v1/files/abc123")) {
        throw new Error(`unexpected URL: ${url}`);
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ token: headers["X-Figma-Token"] }), {
        status: 429,
        headers: { "retry-after": "1" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new FigmaService(makePatAuth(["token-a", "token-b"]));

    await expect(service.getRawFile("abc123")).rejects.toThrow(
      /Exhausted 2 personal access tokens; all were rate limited\./,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not rotate PATs on 403", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://api.figma.com/v1/files/abc123")) {
        throw new Error(`unexpected URL: ${url}`);
      }

      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["X-Figma-Token"] === "token-a") {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
      }

      return Response.json(figmaFileResponse);
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new FigmaService(makePatAuth(["token-a", "token-b"]));

    await expect(service.getRawFile("abc123")).rejects.toThrow(/permission|forbidden|403/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Figma data cache", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
  });

  it("reuses the cached response for the same UI", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "figma-cache-test-"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith("https://api.figma.com/v1/files/abc123")) {
        throw new Error(`unexpected URL: ${url}`);
      }
      return Response.json(figmaFileResponse);
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new FigmaService(makePatAuth(["cache-token"]));
    const cacheOptions = { cacheDir: tmpDir, ttlSeconds: 3600 };

    const first = await getFigmaData(service, { fileKey: "abc123" }, "yaml", {}, cacheOptions);
    const second = await getFigmaData(service, { fileKey: "abc123" }, "yaml", {}, cacheOptions);

    expect(first.formatted).toBe(second.formatted);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(tmpDir)).toHaveLength(1);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
