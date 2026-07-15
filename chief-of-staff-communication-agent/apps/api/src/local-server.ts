import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "@indeedee/db";
import { handleHttpRequest } from "./http/app.js";
import { mergeBody, nodeRequestFromIncoming, readNodeBody, writeNodeResponse } from "./http/from-node.js";
import { startSyncScheduler } from "./services/sync-scheduler.js";

const PORT = Number(process.env.PORT ?? 8787);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

await migrate();

createServer(async (req, res) => {
  const baseUrl = process.env.API_BASE_URL ?? `http://localhost:${PORT}`;
  let httpReq = nodeRequestFromIncoming(req, baseUrl);
  if (req.method !== "GET" && req.method !== "HEAD") {
    httpReq = mergeBody(httpReq, await readNodeBody(req));
  }
  const response = await handleHttpRequest(httpReq, {
    serveWeb: true,
    webRoot: join(repoRoot, "apps/web/public"),
  });
  await writeNodeResponse(res, response);
}).listen(PORT, () => {
  console.log(`Indeedee agent: http://localhost:${PORT}`);
  startSyncScheduler();
});
