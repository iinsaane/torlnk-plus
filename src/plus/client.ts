import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_STATE_DIR, type PlusConfig } from "./config";
import { JsonClient } from "./http";
import type { BackendCapabilities, BackendKind, ControllerSnapshot, ServiceHealth, VpnProfileSummary } from "./contracts";
import type { Credentials } from "./supervisor-core";
export interface AppState { config: PlusConfig; profiles: VpnProfileSummary[]; snapshot: ControllerSnapshot; capabilities: Partial<Record<BackendKind, BackendCapabilities>>; services: ServiceHealth[] }
export async function connectService(start = true): Promise<JsonClient> {
  const stateDir = DEFAULT_STATE_DIR;
  const port = Number(process.env.TORLNK_PLUS_PORT ?? 9161);
  let client: JsonClient | undefined;
  async function existing() {
    const credentials = JSON.parse(await fs.readFile(path.join(stateDir, "credentials.json"), "utf8")) as Credentials;
    client = new JsonClient(`http://127.0.0.1:${port}`, credentials.token, 180000);
    await client.request("/state"); return client;
  }
  try { return await existing(); } catch {}
  if (!start) throw new Error("The torlnk-plus background service is not running");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const logfile = await fs.open(path.join(stateDir, "supervisor.log"), "a", 0o600);
  const entry = fileURLToPath(new URL("./supervisor.js", import.meta.url));
  const child = spawn(process.execPath, [entry], { detached: true, stdio: ["ignore", logfile.fd, logfile.fd], env: { ...process.env, TORLNK_PLUS_STATE_DIR: stateDir } });
  child.unref(); await logfile.close();
  for (let i = 0; i < 100; i++) { try { return await existing(); } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Background service did not start. See ${path.join(stateDir, "supervisor.log")}`);
}
