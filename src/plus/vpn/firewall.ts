/** Basic rule checks, not proof that every firewall exception is safe. */
export function inspectFirewallRules(rules: string): { passed: boolean; defaultDrop: string[]; tunnelEgress: boolean } {
  const filter = rules.match(/^\*filter\r?\n([\s\S]*?)^COMMIT\s*$/m)?.[1] ?? "";
  const defaultDrop = ["INPUT", "FORWARD", "OUTPUT"].filter(chain => new RegExp(`^:${chain} DROP \\[\\d+:\\d+\\]$`, "m").test(filter));
  const tunnelEgress = filter.split(/\r?\n/).some(line => /^-A OUTPUT\b/.test(line) && /(?:^|\s)-o tun0(?:\s|$)/.test(line) && /(?:^|\s)-j ACCEPT(?:\s|$)/.test(line) && !/(?:^|\s)!(?:\s|$)/.test(line));
  return { passed: defaultDrop.length === 3 && tunnelEgress, defaultDrop, tunnelEgress };
}
