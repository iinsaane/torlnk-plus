import { describe, expect, it } from "vitest";
import { doctorPassed, runDoctor, supportsNpm12Node, type Probe } from "./preflight";
import { defaultPlusConfig } from "./config";

function makeProbe(overrides: Partial<Probe> = {}): Probe {
  return {
    platform: "linux", arch: "x64", node: "26.8.1",
    command: async args => args[0] === "version" ? "28.0.0" : args[0] === "compose" ? "2.35.0" : "[]",
    writable: async () => true,
    portAvailable: async () => true,
    readConfig: async () => defaultPlusConfig(),
    authenticatedSupervisor: async () => false,
    tunAvailable: async () => true,
    rootless: async () => false,
    ...overrides,
  };
}

describe("torlnk-plus runtime doctor", () => {
  it("passes supported Linux x64 runtime requirements", async () => {
    const checks = await runDoctor({ stateDir: "/state", probe: makeProbe() });
    expect(doctorPassed(checks)).toBe(true);
    expect(checks.find(c => c.name === "platform")?.message).toContain("Linux x64");
  });

  it("clearly rejects unsupported platforms and old Node versions", async () => {
    const checks = await runDoctor({ stateDir: "/state", probe: makeProbe({ platform: "darwin", arch: "arm64", node: "22.14.0" }) });
    expect(checks.find(c => c.name === "platform")).toMatchObject({ status: "fail", message: expect.stringContaining("Linux x64 only") });
    expect(checks.find(c => c.name === "node")).toMatchObject({ status: "fail", message: expect.stringContaining("22.22.2") });
    expect(doctorPassed(checks)).toBe(false);
  });

  it("reports required Docker, Compose, rootless and directory failures", async () => {
    const checks = await runDoctor({ stateDir: "/state", probe: makeProbe({
      command: async args => args[0] === "version" ? "27.4.0" : args[0] === "compose" ? "" : '["rootless"]',
      writable: async () => false,
      rootless: async () => true,
    }) });
    for (const name of ["docker", "compose", "docker-rootless", "state-directory", "download-directory"]) {
      expect(checks.find(c => c.name === name)?.status).toBe("fail");
    }
  });

  it("checks TUN only for VPN config and detects occupied host ports", async () => {
    const cfg = defaultPlusConfig(); cfg.network.mode = "vpn"; cfg.network.forwardedPort = 6881;
    const checks = await runDoctor({ stateDir: "/state", probe: makeProbe({
      readConfig: async () => cfg, tunAvailable: async () => false,
      portAvailable: async port => port !== 9161,
    }) });
    expect(checks.find(c => c.name === "tun-device")?.status).toBe("fail");
    expect(checks.find(c => c.name === "port-9161")?.status).toBe("fail");
    expect(checks.some(c => c.name === "port-6881")).toBe(false);
  });

  it("recognizes its authenticated running supervisor when checking service ports", async () => {
    const checks = await runDoctor({ stateDir: "/state", probe: makeProbe({ authenticatedSupervisor: async () => true, portAvailable: async () => false }) });
    expect(checks.find(c => c.name === "port-9161")?.message).toContain("authenticated running");
    expect(checks.find(c => c.name === "port-8080")?.status).toBe("pass");
    expect(checks.some(c => c.name === "port-6881")).toBe(false);
  });

  it("allows forwardedPort to equal listenPort and probes only host-published ports", async () => {
    const cfg = defaultPlusConfig(); cfg.network.forwardedPort = cfg.backendSettings.listenPort;
    const probed: number[] = [];
    const checks = await runDoctor({ stateDir: "/state", probe: makeProbe({
      readConfig: async () => cfg,
      portAvailable: async port => { probed.push(port); return true; },
    }) });
    expect(checks.find(c => c.name === "port-duplicates")).toMatchObject({ status: "pass" });
    expect(probed).toEqual([9161, 9162, 8080]);
  });

  it("detects the next-port WebTorrent listener reaching 65536 or an internal listener", async () => {
    const cfg = defaultPlusConfig(); cfg.backendSettings.listenPort = 65535;
    let checks = await runDoctor({ stateDir: "/state", probe: makeProbe({ readConfig: async () => cfg }) });
    expect(checks.find(c => c.name === "port-ranges")?.status).toBe("fail");
    cfg.network.forwardedPort = 9162;
    checks = await runDoctor({ stateDir: "/state", probe: makeProbe({ readConfig: async () => cfg }) });
    expect(checks.find(c => c.name === "port-duplicates")?.status).toBe("fail");
  });

  it("rejects Compose v1 and an unknown Docker security mode", async () => {
    const checks = await runDoctor({ stateDir: "/state", probe: makeProbe({
      command: async args => args[0] === "version" ? "28.0.0" : args[0] === "compose" ? "1.29.2" : "not json",
      rootless: async () => null,
    }) });
    expect(checks.find(c => c.name === "compose")?.status).toBe("fail");
    expect(checks.find(c => c.name === "docker-rootless")).toMatchObject({ status: "fail", message: expect.stringContaining("could not be determined") });
  });

  it.each([
    ["22.22.1", false], ["22.22.2", true], ["22.23.0", true],
    ["24.14.0", false], ["24.15.0", true], ["25.0.0", false],
    ["26.0.0", true], ["26.8.1", true], ["27.0.0", true], ["23.9.0", false],
  ])("NPM 12 Node support for %s is %s", (version, supported) => {
    expect(supportsNpm12Node(version)).toBe(supported);
  });
});
