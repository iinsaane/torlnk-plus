import { describe, expect, it } from "vitest";
import { inspectFirewallRules } from "./firewall";

const filter = "*filter\n:INPUT DROP [1:2]\n:FORWARD DROP [0:0]\n:OUTPUT DROP [0:0]\n-A OUTPUT -o tun0 -j ACCEPT\nCOMMIT\n";
describe("live firewall posture inspection", () => {
  it("requires all filter default policies and an explicit tunnel allow", () => {
    expect(inspectFirewallRules(filter).passed).toBe(true);
    for (const chain of ["INPUT", "FORWARD", "OUTPUT"]) {
      expect(inspectFirewallRules(filter.replace(`:${chain} DROP`, `:${chain} ACCEPT`)).passed).toBe(false);
    }
    expect(inspectFirewallRules(filter.replace("-o tun0", "-o eth0")).passed).toBe(false);
  });
  it("does not mistake another table, chain, negation, or malformed output for protection", () => {
    for (const rules of ["", filter.replace("*filter", "*nat"), filter.replace("-A OUTPUT", "-A INPUT"), filter.replace("-o tun0", "! -o tun0"), filter.replace("-j ACCEPT", "-j DROP"), filter.replace("COMMIT", "")]) {
      expect(inspectFirewallRules(rules).passed).toBe(false);
    }
  });
});
