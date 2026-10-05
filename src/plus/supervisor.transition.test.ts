import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Supervisor } from "./supervisor-core";
import { importVpnProfile } from "./vpn/profiles";
import type { ControllerSnapshot } from "./contracts";

const mocks = vi.hoisted(() => ({
  events: [] as unknown[],
  failVpn: false,
  gatewayFails: false,
  unavailableBackend: false,
  tokens: [
    { backend: "webtorrent", id: "w".repeat(40) },
    { backend: "qbittorrent", id: "q".repeat(40) },
  ],
}));

vi.mock("./vpn/runtime", () => ({
  DockerRuntime: class {
    constructor(_options: unknown) { mocks.events.push(["runtime.construct"]); }
    async stop() { mocks.events.push(["runtime.stop"]); }
    async start(mode: string, profile?: { id: string }) {
      mocks.events.push(["runtime.start", mode, profile?.id]);
      if (mode === "vpn" && mocks.failVpn) throw new Error("simulated tunnel startup failure");
      return mode === "vpn" ? { mode, state: "Protected", profileId: profile?.id } : { mode, state: "Direct" };
    }
    getEndpoints() { return { controller: "http://controller.test", qbittorrent: "http://qbit.test" }; }
    async status() {
      mocks.events.push(["runtime.status"]);
      if (mocks.gatewayFails) throw new Error("gateway unavailable");
      return { mode: "direct", state: "Direct", message: "gateway ready" };
    }
  },
}));

vi.mock("./http", () => ({
  JsonClient: class {
    constructor(_url: string, _token: string, _timeout?: number) { mocks.events.push(["worker.construct"]); }
    async request(route: string, body?: Record<string, unknown>) {
      mocks.events.push(["worker.request", route, body]);
      if (route === "/snapshot") return {
        torrents: [], backends: [
          { backend: "qbittorrent", available: !mocks.unavailableBackend, ...(mocks.unavailableBackend ? { message: "qBittorrent down" } : {}) },
          { backend: "webtorrent", available: true },
        ], route: { mode: "direct", state: "Direct" },
      } satisfies ControllerSnapshot;
      if (route === "/capabilities") return {};
      if (route === "/searchHealth") return { available: true };
      if (body?.action === "pauseActive") return mocks.tokens;
      return null;
    }
  },
}));

const roots: string[] = [];
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plus-supervisor-transition-"));
  roots.push(dir);
  const profileSource = path.join(dir, "profile.conf");
  const secret = Buffer.alloc(32, 3).toString("base64");
  const config = "[Interface]\nPrivateKey = " + secret + "\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = " + Buffer.alloc(32, 4).toString("base64") + "\nEndpoint = vpn.example.org:51820\nAllowedIPs = 0.0.0.0/0\n";
  await writeFile(profileSource, config);
  const profile = await importVpnProfile(profileSource, path.join(dir, "profiles"), { name: "Test VPN" });
  const supervisor = new Supervisor(dir, dir, { token: "t".repeat(64), workerToken: "w".repeat(64), qbitPassword: "q".repeat(64) });
  return { dir, profile, supervisor };
}

beforeEach(() => {
  mocks.events.length = 0;
  mocks.failVpn = false;
  mocks.gatewayFails = false;
  mocks.unavailableBackend = false;
  mocks.tokens = [{ backend: "webtorrent", id: "w".repeat(40) }, { backend: "qbittorrent", id: "q".repeat(40) }];
});
afterEach(async () => { await Promise.all(roots.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

function events() { return mocks.events.filter((x): x is unknown[] => Array.isArray(x)); }
function commandActions() {
  return events().filter(x => x[0] === "worker.request" && x[1] === "/command").map(x => (x[2] as { action: string }).action);
}

describe("Supervisor routing transitions", () => {
  it("pauses and checkpoints before stopping, then starts, applies settings, and resumes mixed-backend active tokens", async () => {
    const { dir, profile, supervisor } = await fixture();
    try {
      await supervisor.setRouting("direct");
      mocks.events.length = 0;
      await supervisor.setRouting("vpn", profile.id);
      const rows = events();
      const index = (predicate: (x: unknown[]) => boolean) => rows.findIndex(predicate);
      const pause = index(x => x[0] === "worker.request" && x[1] === "/command" && (x[2] as { action: string }).action === "pauseActive");
      const checkpoint = index(x => x[0] === "worker.request" && x[1] === "/command" && (x[2] as { action: string }).action === "checkpoint");
      const stop = index(x => x[0] === "runtime.stop");
      const start = index(x => x[0] === "runtime.start" && x[1] === "vpn");
      const apply = index(x => x[0] === "worker.request" && x[1] === "/command" && (x[2] as { action: string }).action === "applySettings");
      const resume = index(x => x[0] === "worker.request" && x[1] === "/command" && (x[2] as { action: string }).action === "resumeActive");
      expect(pause).toBeLessThan(checkpoint);
      expect(checkpoint).toBeLessThan(stop);
      expect(stop).toBeLessThan(start);
      expect(start).toBeLessThan(apply);
      expect(apply).toBeLessThan(resume);
      expect(commandActions()).toEqual(["pauseActive", "checkpoint", "applySettings", "resumeActive"]);
      expect((rows[resume]![2] as { tokens: unknown[] }).tokens).toEqual(mocks.tokens);
      await expect(readFile(path.join(dir, "transition.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await supervisor.stop(); }
  });

  it("keeps failed VPN routing blocked and retries direct with only the saved active tokens", async () => {
    const { dir, profile, supervisor } = await fixture();
    try {
      await supervisor.setRouting("direct");
      mocks.events.length = 0;
      mocks.failVpn = true;
      await expect(supervisor.setRouting("vpn", profile.id)).rejects.toThrow("simulated tunnel startup failure");
      expect((await supervisor.state()).snapshot.route).toMatchObject({ mode: "vpn", state: "Blocked" });
      expect(JSON.parse(await readFile(path.join(dir, "config.json"), "utf8")).network).toMatchObject({ mode: "vpn", profileId: profile.id });
      expect(JSON.parse(await readFile(path.join(dir, "transition.json"), "utf8")).tokens).toEqual(mocks.tokens);
      mocks.events.length = 0;
      mocks.failVpn = false;
      await supervisor.setRouting("direct");
      expect(commandActions()).toEqual(["applySettings", "resumeActive"]);
      const resume = events().find(x => x[0] === "worker.request" && x[1] === "/command" && (x[2] as { action: string }).action === "resumeActive")!;
      expect((resume[2] as { tokens: unknown[] }).tokens).toEqual(mocks.tokens);
      expect((await supervisor.state()).snapshot.route).toMatchObject({ mode: "direct", state: "Direct" });
      await expect(readFile(path.join(dir, "transition.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await supervisor.stop(); }
  });

  it("reports search and each backend independently when one backend is unavailable", async () => {
    const { supervisor } = await fixture();
    try {
      await supervisor.setRouting("direct");
      mocks.unavailableBackend = true;
      const state = await supervisor.state();
      expect(state.services.find(s => s.service === "supervisor")?.state).toBe("healthy");
      expect(state.services.find(s => s.service === "gateway")?.state).toBe("healthy");
      expect(state.services.find(s => s.service === "search")?.state).toBe("healthy");
      expect(state.services.find(s => s.service === "qbittorrent")?.state).toBe("unavailable");
      expect(state.services.find(s => s.service === "webtorrent")?.state).toBe("healthy");
    } finally { await supervisor.stop(); }
  });

  it("marks direct gateway loss blocked and blocks search", async () => {
    const { supervisor } = await fixture();
    try {
      await supervisor.setRouting("direct");
      mocks.gatewayFails = true;
      await (supervisor as unknown as { checkHealth(): Promise<void> }).checkHealth();
      const state = await supervisor.state();
      expect(state.snapshot.route.state).toBe("Blocked");
      expect(state.services.find(s => s.service === "gateway")?.state).toBe("blocked");
      await expect(supervisor.search("test")).rejects.toThrow("Search is blocked until routing is ready");
    } finally { await supervisor.stop(); }
  });
});
