import type { Channel, Connector } from "@indeedee/shared";
import { getConnectorCredentials } from "@indeedee/db";
import { createConnector } from "./registry.js";

import "./demo.js";
import "./gmail.js";
import "./imap.js";
import "./twilio.js";
import "./x.js";

export async function connectorsForOwner(ownerId: string): Promise<Connector[]> {
  const { listConnectorTokens } = await import("@indeedee/db");
  const tokens = await listConnectorTokens(ownerId);
  return Promise.all(
    tokens
      .filter((t) => t.accountHandle !== "__asana__")
      .map(async (t) => {
        const creds = await getConnectorCredentials(ownerId, t.channel, t.accountHandle);
        if (creds?.mode === "integration") return null;
        return createConnector(t.channel, {
          accountHandle: t.accountHandle,
          credentials: creds ?? { mode: "demo" },
        });
      }),
  ).then((list) => list.filter((c): c is Connector => c !== null));
}

export async function connectorFor(
  ownerId: string,
  channel: Channel,
  accountHandle: string,
): Promise<Connector | null> {
  const creds = await getConnectorCredentials(ownerId, channel, accountHandle);
  if (!creds) return null;
  return createConnector(channel, { accountHandle, credentials: creds });
}
