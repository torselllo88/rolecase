import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchBroker } from "../../src/tools/searchBroker.js";

describe("SearchBroker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a deterministic stub when no API key is configured", async () => {
    const broker = new SearchBroker(0, undefined);
    const result = await broker.execute({ query: "Acme culture" }, {});

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.url).toContain("example.com");
  });

  it("calls the real Brave Search endpoint and maps the response when an API key is injected", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("api.search.brave.com");
      expect(String(url)).toContain("q=acme+culture");
      return new Response(
        JSON.stringify({
          web: {
            results: [{ url: "https://glassdoor.com/acme", title: "Acme Reviews", description: "4.2 stars" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const broker = new SearchBroker(0, "fake-api-key");
    const result = await broker.execute({ query: "acme culture" }, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      results: [{ url: "https://glassdoor.com/acme", title: "Acme Reviews", snippet: "4.2 stars" }],
      cacheHit: false,
    });
  });

  it("throws a clear error when the real API call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }))
    );

    const broker = new SearchBroker(0, "bad-key");
    await expect(broker.execute({ query: "acme" }, {})).rejects.toThrow(/401/);
  });

  it("serves repeated queries from cache without a second network call", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const broker = new SearchBroker(0, "fake-api-key");
    await broker.execute({ query: "acme" }, {});
    const second = await broker.execute({ query: "acme" }, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.cacheHit).toBe(true);
  });
});
