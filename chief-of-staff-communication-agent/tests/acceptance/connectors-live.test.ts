import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnector } from "@indeedee/connectors";

describe("live connector paths (mocked providers)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Gmail live fetch maps API messages to InboundMessage", async () => {
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "sec";

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
        });
      }
      if (url.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), { status: 200 });
      }
      if (url.includes("/messages/m1?")) {
        return new Response(
          JSON.stringify({
            id: "m1",
            threadId: "t1",
            internalDate: String(Date.now()),
            payload: {
              headers: [
                { name: "From", value: "Alex <alex@fund.com>" },
                { name: "To", value: "exec@company.com" },
                { name: "Subject", value: "Hello" },
              ],
              mimeType: "text/plain",
              body: { data: Buffer.from("Hi there").toString("base64url") },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const conn = createConnector("gmail", {
      accountHandle: "exec@company.com",
      credentials: { mode: "live", refreshToken: "rtok" },
    });
    const msgs = await conn.fetch();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.channel).toBe("gmail");
    expect(msgs[0]?.sender.handle).toContain("alex@fund.com");
    expect(msgs[0]?.bodyText).toContain("Hi there");
  });

  it("Twilio live fetch filters SMS vs WhatsApp", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          messages: [
            {
              sid: "SM1",
              direction: "inbound",
              from: "+15551111",
              to: "+15552222",
              body: "sms hello",
              date_created: new Date().toISOString(),
            },
            {
              sid: "WA1",
              direction: "inbound",
              from: "whatsapp:+15553333",
              to: "whatsapp:+15554444",
              body: "wa hello",
              date_created: new Date().toISOString(),
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sms = createConnector("sms", {
      accountHandle: "+15552222",
      credentials: {
        mode: "live",
        accountSid: "AC",
        authToken: "tok",
        fromNumber: "+15552222",
      },
    });
    const smsMsgs = await sms.fetch();
    expect(smsMsgs.some((m) => m.bodyText === "sms hello")).toBe(true);
    expect(smsMsgs.some((m) => m.bodyText === "wa hello")).toBe(false);
  });

  it("Gmail live health check uses profile API", async () => {
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "sec";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
        });
      }
      if (url.includes("/profile")) {
        return new Response(JSON.stringify({ emailAddress: "exec@company.com" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { testChannelConnection } = await import("@indeedee/connectors");
    const result = await testChannelConnection("gmail", "exec@company.com", {
      mode: "live",
      refreshToken: "rtok",
    });
    expect(result.ok).toBe(true);
    expect(result.label).toBe("exec@company.com");
    expect(result.mode).toBe("live");
  });
});
