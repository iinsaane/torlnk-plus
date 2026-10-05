import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Supervisor } from "./supervisor-core";
it("reports each service independently before setup and refuses VPN without a profile", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plus-supervisor-"));
  const supervisor = new Supervisor(dir, dir, { token: "t".repeat(64), workerToken: "w".repeat(64), qbitPassword: "q".repeat(64) });
  try {
    const initial = await supervisor.state();
    expect(initial.config.network.mode).toBeNull();
    expect(initial.services.map(s => s.service)).toEqual(["supervisor", "controller", "gateway", "search", "qbittorrent", "webtorrent"]);
    expect(initial.services.find(s => s.service === "supervisor")?.state).toBe("healthy");
    expect(initial.services.find(s => s.service === "gateway")?.state).toBe("blocked");
    expect(initial.services.find(s => s.service === "qbittorrent")?.lastSuccessAt).toBeUndefined();
    await expect(supervisor.setRouting("vpn")).rejects.toThrow("Select an imported VPN profile");
    expect((await supervisor.state()).snapshot.route.state).toBe("Blocked");
  } finally { await supervisor.stop(); await rm(dir, { recursive: true, force: true }); }
});
