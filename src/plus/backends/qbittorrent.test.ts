import { describe, expect, it, vi } from "vitest";
import parseTorrent from "parse-torrent";
import { QbittorrentBackend } from "./qbittorrent.js";

const HASH = "0123456789abcdef0123456789abcdef01234567";
const torrent = (extra: Record<string, unknown> = {}) => ({ hash: HASH, name: "Demo", state: "downloading", progress: 0.25, size: 1000, downloaded: 250, uploaded: 10, dlspeed: 20, upspeed: 2, save_path: "/data", ...extra });
const response = (body = "Ok.", init?: ResponseInit) => new Response(body, init);

function harness(handler: (url: URL, init: RequestInit, calls: { logins: number }) => Response | Promise<Response>) {
  const calls = { logins: 0 };
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/auth/login")) calls.logins++;
    return handler(url, init, calls);
  }) as unknown as typeof fetch;
  return { fetcher: fetcher as typeof fetch & ReturnType<typeof vi.fn>, calls, backend: new QbittorrentBackend({ baseUrl: "http://localhost:8080/qb/", username: "u", password: "p", fetch: fetcher }) };
}
const loginResponse = () => new Response("Ok.", { headers: { "set-cookie": "SID=test-session; path=/" } });
const torrentBytes = Buffer.concat([
  Buffer.from("d4:infod6:lengthi1e4:name4:demo12:piece lengthi16384e6:pieces20:"),
  Buffer.alloc(20, 112), Buffer.from("ee"),
]);

describe("QbittorrentBackend", () => {
  it("logs in with same-origin protection headers, verifies 5.x readiness, and normalizes torrent states", async () => {
    const { backend, fetcher } = harness((url, init) => {
      expect(new Headers(init.headers).get("Referer")).toBe("http://localhost:8080/qb/");
      expect(new Headers(init.headers).get("Origin")).toBe("http://localhost:8080");
      if (url.pathname.endsWith("/auth/login")) return loginResponse();
      if (url.pathname.endsWith("/app/version")) return response("v5.1.2");
      if (url.pathname.endsWith("/app/webapiVersion")) return response("2.11.3");
      if (url.pathname.endsWith("/torrents/info")) return response(JSON.stringify([torrent(), torrent({ hash: "b", state: "metaDL", progress: 0 }), torrent({ hash: "c", state: "checkingDL" }), torrent({ hash: "d", state: "pausedUP", progress: 1 }), torrent({ hash: "e", state: "error" })]));
      throw new Error(url.pathname);
    });
    await backend.start();
    const list = await backend.list();
    expect(list.map(t => t.state)).toEqual(["downloading", "metadata", "checking", "completed", "failed"]);
    expect(list[0]).toMatchObject({ progress: 0.25, total: 1000, downloaded: 250, downloadSpeed: 20, backend: "qbittorrent" });
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("SID=test-session");
  });

  it("accepts the qBittorrent 5.2 port-specific cookie and empty 204 login response", async () => {
    const { backend } = harness((url, init) => {
      if (url.pathname.endsWith("/auth/login")) return new Response(null, { status: 204, headers: { "set-cookie": "QBT_SID_8080=modern-session; path=/; HttpOnly" } });
      expect(new Headers(init.headers).get("Cookie")).toBe("QBT_SID_8080=modern-session");
      return response("[]");
    });
    expect(await backend.list()).toEqual([]);
  });

  it("parses torrent bytes and magnets and returns the canonical hash", async () => {
    const canonical = (await parseTorrent(torrentBytes)).infoHash;
    let items: Record<string, unknown>[] = [];
    let uploaded = false;
    const { backend } = harness(async (url, init) => {
      if (url.pathname.endsWith("/auth/login")) return loginResponse();
      if (url.pathname.endsWith("/torrents/info")) return response(JSON.stringify(items));
      if (url.pathname.endsWith("/torrents/add")) {
        const form = init.body as FormData;
        expect(form.get("savepath")).toBe("/downloads");
        expect(form.get("paused")).toBe(uploaded ? "false" : "true");
        if (form.has("torrents")) {
          const file = form.get("torrents") as File;
          expect(file.name).toBe("upload.torrent");
          expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...torrentBytes]);
          uploaded = true;
        }
        if (form.has("urls")) expect(form.get("urls")).toBe(`magnet:?xt=urn:btih:${HASH}`);
        items = [torrent({ hash: form.has("urls") ? HASH : canonical, state: "metaDL", progress: 0 })];
        return form.has("torrents") ? response(JSON.stringify({ added_torrent_ids: [canonical], failure_count: 1, pending_count: 0, success_count: 1 })) : response();
      }
      throw new Error(url.pathname);
    });
    const id = await backend.add({ torrentBase64: torrentBytes.toString("base64"), savePath: "/downloads", paused: true });
    expect(id).toBe(canonical);
    expect(uploaded).toBe(true);
    const magnetId = await backend.add({ magnet: `magnet:?xt=urn:btih:${HASH}`, savePath: "/downloads" });
    expect(magnetId).toBe(HASH);
  });

  it("rejects an id that conflicts with parsed torrent metadata", async () => {
    const { backend } = harness(url => url.pathname.endsWith("/auth/login") ? loginResponse() : response("[]"));
    await expect(backend.add({ magnet: `magnet:?xt=urn:btih:${HASH}`, id: "f".repeat(40), savePath: "/downloads" })).rejects.toThrow(/does not match/);
  });

  it("uses hashes for single-torrent queries and maps timestamps, peers and stopped states", async () => {
    let infoQuery = "";
    const { backend } = harness(url => {
      if (url.pathname.endsWith("/auth/login")) return loginResponse();
      if (url.pathname.endsWith("/torrents/info")) {
        infoQuery = url.search;
        const other = torrent({ hash: "a".repeat(40), name: "Other" });
        const target = torrent({ state: "stoppedDL", progress: 0.3, added_on: 10, completion_on: 20, num_seeds: 4, num_leechs: 3 });
        return response(JSON.stringify(url.searchParams.get("hashes") === HASH ? [target] : [other, target]));
      }
      if (url.pathname.endsWith("/torrents/files")) return response("[]");
      if (url.pathname.endsWith("/torrents/trackers")) return response(JSON.stringify([{url:"https://tracker.example/announce",status:2,msg:""},{url:"https://offline.example/announce",status:4,msg:"Connection refused"}]));
      if (url.pathname.endsWith("/torrents/properties")) return response("{}");
      throw new Error(url.pathname);
    });
    const details = await backend.details(HASH);
    expect(details.trackers).toMatchObject([{status:"working"},{status:"not working",message:"Connection refused"}]);
    expect(infoQuery).toBe(`?hashes=${HASH}`);
    expect(details.torrent).toMatchObject({ id: HASH, name: "Demo", state: "paused", peers: 7, seeders: 4, addedAt: 10_000, completedAt: 20_000 });
  });

  it.each([401, 403])("retries once after an expired SID (HTTP %i) and serializes concurrent login", async (status) => {
    const { backend, calls } = harness((url, init, state) => {
      if (url.pathname.endsWith("/auth/login")) return loginResponse();
      const cookie = new Headers(init.headers).get("Cookie");
      if (url.pathname.endsWith("/torrents/info")) return response("[]");
      throw new Error(url.pathname);
    });
    // Run a pair together before a session exists; both share the in-flight login.
    await Promise.all([backend.list(), backend.list()]);
    expect(calls.logins).toBe(1);
    // A fresh adapter exercises one 403 -> one relogin -> successful retry.
    const second = harness((url, init, state) => {
      if (url.pathname.endsWith("/auth/login")) return loginResponse();
      if (url.pathname.endsWith("/torrents/info") && state.logins === 1) return response("", { status });
      if (url.pathname.endsWith("/torrents/info")) return response("[]");
      throw new Error(url.pathname);
    });
    await second.backend.list();
    expect(second.calls.logins).toBe(2);
    expect(second.fetcher).toHaveBeenCalledTimes(4);
  });

  it("uses safe delete defaults, API units, trackers, and correct piece mappings", async () => {
    const posts: Array<{ path: string; body: URLSearchParams }> = [];
    const { backend } = harness((url, init) => {
      if (url.pathname.endsWith("/auth/login")) return loginResponse();
      if (init.method === "POST") {
        posts.push({ path: url.pathname, body: new URLSearchParams(String(init.body)) });
        return response();
      }
      if (url.pathname.endsWith("/torrents/info")) return response(JSON.stringify([torrent({ piece_size: 256 })]));
      if (url.pathname.endsWith("/torrents/pieceStates")) return response("[0,1,2,9]");
      if (url.pathname.endsWith("/torrents/properties")) return response(JSON.stringify({ piece_size: 256 }));
      throw new Error(url.pathname);
    });
    await backend.remove(HASH);
    await backend.recheck(HASH);
    await backend.applySettings({ downloadLimitKiB: 16, uploadLimitKiB: 8, maxDownloads: 0, maxConnections: 50, utp: true, seedRatio: 0, seedTimeMinutes: 0, dht: false, pex: true, trackers: ["udp://tracker.example:80/announce"] });
    expect(posts.find(p => p.path.endsWith("/torrents/delete"))?.body.get("deleteFiles")).toBe("false");
    expect(posts.find(p => p.path.endsWith("/transfer/setDownloadLimit"))?.body.get("limit")).toBe("16384");
    expect(JSON.parse(posts.find(p => p.path.endsWith("/app/setPreferences"))!.body.get("json")!)).toMatchObject({ dht: false, pex: true, bittorrent_protocol: 0, max_active_downloads: -1, max_connec: 50, max_ratio_enabled: false, max_ratio: -1, max_seeding_time_enabled: false, max_seeding_time: -1, add_trackers_enabled: true });
    expect(posts.find(p => p.path.endsWith("/torrents/addTrackers"))?.body.get("hash")).toBe(HASH);
    expect((await backend.pieces(HASH))?.states).toEqual(["missing", "active", "verified", "unknown"]);
  });

  it("returns null when qBittorrent has no valid piece size", async () => {
    const { backend } = harness(url => {
      if (url.pathname.endsWith("/auth/login")) return loginResponse();
      if (url.pathname.endsWith("/torrents/info")) return response(JSON.stringify([torrent()]));
      if (url.pathname.endsWith("/torrents/properties")) return response(JSON.stringify({ piece_size: 0 }));
      if (url.pathname.endsWith("/torrents/pieceStates")) return response("[]");
      throw new Error(url.pathname);
    });
    await expect(backend.pieces(HASH)).resolves.toBeNull();
  });

  it("surfaces bad credentials, unsupported versions, HTTP errors, and body failures", async () => {
    const badLogin = harness(url => url.pathname.endsWith("/auth/login") ? response("Fails.", { headers: { "set-cookie": "SID=nope" } }) : response("[]"));
    await expect(badLogin.backend.start()).rejects.toThrow(/rejected credentials/);
    const old = harness(url => url.pathname.endsWith("/auth/login") ? loginResponse() : url.pathname.endsWith("/app/version") ? response("v4.6.7") : response("2.11"));
    await expect(old.backend.start()).rejects.toThrow(/5.0\+ required/);
    const failure = harness(url => url.pathname.endsWith("/auth/login") ? loginResponse() : response("", { status: 500 }));
    await expect(failure.backend.list()).rejects.toThrow(/HTTP 500/);
    const bodyFailure = harness(url => url.pathname.endsWith("/auth/login") ? loginResponse() : response("Fails."));
    await expect(bodyFailure.backend.list()).rejects.toThrow(/failure response/);
  });
});
