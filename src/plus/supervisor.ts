import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Supervisor, type Credentials } from "./supervisor-core";
import { DEFAULT_STATE_DIR } from "./config";
import { authenticatedServer } from "./http";
const stateDir = DEFAULT_STATE_DIR;
await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
await fs.chmod(stateDir, 0o700);
const credentialsPath = path.join(stateDir, "credentials.json");
let credentials: Credentials;
try { credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8")); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  credentials = { token: randomBytes(32).toString("hex"), workerToken: randomBytes(32).toString("hex"), qbitPassword: randomBytes(32).toString("hex") };
  await fs.writeFile(credentialsPath, JSON.stringify(credentials), { mode: 0o600, flag: "wx" });
}
const projectDir = process.env.TORLNK_PLUS_PROJECT_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supervisor = new Supervisor(projectDir, stateDir, credentials);
const server = authenticatedServer(credentials.token, async (url, body, req) => {
  if (url.pathname === "/state" && req.method === "GET") return supervisor.state();
  if (req.method !== "POST") throw new Error("Unknown endpoint");
  switch (url.pathname) {
    case "/config": return supervisor.saveConfig(body.config as never);
    case "/route": return supervisor.setRouting(body.mode as never, body.profileId as string | undefined);
    case "/profiles/import": if (typeof body.path !== "string") throw new Error("A profile path is required"); return supervisor.importProfile(body.path, body.options as never);
    case "/profiles/remove": return supervisor.removeProfile(String(body.id));
    case "/command": return supervisor.command(body);
    case "/search": return supervisor.search(String(body.query ?? ""));
    case "/stop": await supervisor.stop(); setTimeout(() => { server.close(); process.exit(0); }, 100); return null;
    default: throw new Error("Unknown endpoint");
  }
});
server.listen(Number(process.env.TORLNK_PLUS_PORT ?? 9161), "127.0.0.1", () => { void fs.writeFile(path.join(stateDir, "supervisor.pid"), String(process.pid), { mode: 0o600 }); void supervisor.start(); });
server.on("error", () => process.exit(1));
async function shutdown() { await supervisor.stop().catch(() => {}); server.close(); process.exit(0); }
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
