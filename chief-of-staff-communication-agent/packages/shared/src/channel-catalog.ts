import type { Channel } from "./domain.js";

/** How a channel is connected in the UI — mirrors PR-3 provider kinds, kit-native. */
export type ChannelConnectKind = "oauth" | "credentials" | "unavailable" | "demo";

export interface CredentialFieldDef {
  key: string;
  label: string;
  type: "text" | "email" | "password";
  placeholder?: string;
  required?: boolean;
  hint?: string;
  /** When reconnecting, prefill this field from the stored account handle. */
  handleField?: boolean;
}

export interface ChannelCatalogEntry {
  id: Channel | "asana";
  label: string;
  description: string;
  kind: ChannelConnectKind;
  helpHtml?: string;
  steps?: string[];
  noteHtml?: string;
  helpUrl?: string;
  fields?: CredentialFieldDef[];
}

/** Declarative connect metadata — single source for API + vanilla UI (PR-1/PR-3 pattern). */
export const CHANNEL_CATALOG: ChannelCatalogEntry[] = [
  {
    id: "gmail",
    label: "Gmail",
    description: "Google OAuth — read inbox and send after approval",
    kind: "oauth",
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    helpHtml:
      "Connect with Google OAuth. Requires <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in server env.",
    steps: [
      "Create an OAuth 2.0 Web client in Google Cloud Console.",
      "Add redirect URI: <code>{origin}/api/oauth/google/callback</code>",
      "Click Connect — you will sign in with Google and grant Gmail read/send.",
    ],
  },
  {
    id: "email",
    label: "Email (IMAP)",
    description: "Zoho, Fastmail, Outlook, or any IMAP mailbox",
    kind: "credentials",
    helpHtml:
      "The agent reads your inbox and, once you approve a draft, replies as you. Use an <b>app password</b>, not your login password.",
    steps: [
      "Enable IMAP in your mail provider settings.",
      "Create an app-specific password.",
      "Enter your address and app password below.",
    ],
    noteHtml:
      "Common hosts: Zoho <code>imap.zoho.com</code> · Gmail <code>imap.gmail.com</code> · Outlook <code>outlook.office365.com</code>. Leave host blank to auto-detect.",
    fields: [
      {
        key: "email",
        label: "Email address",
        type: "email",
        placeholder: "you@company.com",
        required: true,
        handleField: true,
        hint: "The mailbox the agent will manage.",
      },
      {
        key: "password",
        label: "App password",
        type: "password",
        placeholder: "xxxx xxxx xxxx xxxx",
        required: true,
        hint: "App-specific password — not your login password.",
      },
      {
        key: "imapHost",
        label: "IMAP host (optional)",
        type: "text",
        placeholder: "imap.zoho.com",
        hint: "Leave blank unless your provider is not auto-detected.",
      },
    ],
  },
  {
    id: "sms",
    label: "SMS (Twilio)",
    description: "Your Twilio phone number",
    kind: "credentials",
    helpUrl: "https://console.twilio.com",
    helpHtml: "Reads and sends SMS on <b>your Twilio number</b> — not your personal cell.",
    steps: [
      "Buy or select a Twilio number with SMS enabled.",
      "Copy Account SID and Auth Token from the console.",
      "Paste them below with your number in E.164 format.",
    ],
    fields: [
      {
        key: "fromNumber",
        label: "Twilio number",
        type: "text",
        placeholder: "+15551234567",
        required: true,
        handleField: true,
      },
      {
        key: "accountSid",
        label: "Account SID",
        type: "text",
        placeholder: "AC…",
        required: true,
      },
      { key: "authToken", label: "Auth Token", type: "password", required: true },
    ],
  },
  {
    id: "whatsapp",
    label: "WhatsApp (Twilio)",
    description: "Twilio WhatsApp Business sender",
    kind: "credentials",
    helpUrl: "https://www.twilio.com/docs/whatsapp/sandbox",
    helpHtml: "Uses your Twilio WhatsApp sender (sandbox or approved business number).",
    steps: [
      "Set up a WhatsApp sender in Twilio (sandbox for testing).",
      "Use the same Account SID + Auth Token as SMS.",
      "Paste credentials and your WhatsApp-enabled number.",
    ],
    fields: [
      {
        key: "fromNumber",
        label: "WhatsApp-enabled number",
        type: "text",
        placeholder: "+14155238886",
        required: true,
        handleField: true,
      },
      {
        key: "accountSid",
        label: "Account SID",
        type: "text",
        placeholder: "AC…",
        required: true,
      },
      { key: "authToken", label: "Auth Token", type: "password", required: true },
    ],
  },
  {
    id: "x",
    label: "X (Twitter DMs)",
    description: "OAuth2 user token with dm.read + dm.write",
    kind: "credentials",
    helpUrl: "https://developer.x.com/en/portal/dashboard",
    helpHtml: "Requires your own X developer app with DM API access.",
    steps: [
      "Create an X app with OAuth 2.0 and dm.read + dm.write scopes.",
      "Generate an OAuth2 user access token for your account.",
      "Paste token, numeric user id, and handle below.",
    ],
    fields: [
      {
        key: "accessToken",
        label: "OAuth2 user access token",
        type: "password",
        required: true,
      },
      {
        key: "selfUserId",
        label: "Numeric X user id",
        type: "text",
        placeholder: "1234567890",
        required: true,
      },
      {
        key: "selfHandle",
        label: "Your handle",
        type: "text",
        placeholder: "@you",
        required: true,
        handleField: true,
      },
    ],
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    description: "No compliant personal-messaging API",
    kind: "unavailable",
    helpHtml: "LinkedIn does not offer a public API for personal inbox messaging. Not available.",
  },
  {
    id: "asana",
    label: "Asana",
    description: "Personal access token for task creation",
    kind: "credentials",
    helpUrl: "https://app.asana.com/0/my-apps",
    helpHtml: "Lets the agent create follow-up tasks in your Asana workspace.",
    steps: [
      "Open Asana → Apps → Personal access tokens.",
      "Create a token and copy it — shown once.",
      "Paste below. Stored per owner, never logged.",
    ],
    fields: [
      {
        key: "pat",
        label: "Personal Access Token",
        type: "password",
        placeholder: "2/1216…",
        required: true,
      },
    ],
  },
];

export function getCatalogEntry(id: string): ChannelCatalogEntry | undefined {
  return CHANNEL_CATALOG.find((c) => c.id === id);
}

/** Map modal form values → Indeedee connect contract (stored in connector_tokens). */
export function buildConnectPayload(
  channelId: string,
  values: Record<string, string>,
): { channel: Channel; accountHandle: string; credentials: Record<string, string> } {
  const trimmed = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, v.trim()]),
  );

  switch (channelId) {
    case "email": {
      const email = trimmed.email;
      if (!email || !trimmed.password) throw new Error("Email and app password are required");
      return {
        channel: "email",
        accountHandle: email,
        credentials: {
          mode: "live",
          password: trimmed.password,
          ...(trimmed.imapHost ? { imapHost: trimmed.imapHost } : {}),
        },
      };
    }
    case "sms":
    case "whatsapp": {
      const fromNumber = trimmed.fromNumber;
      if (!fromNumber || !trimmed.accountSid || !trimmed.authToken) {
        throw new Error("Twilio number, Account SID, and Auth Token are required");
      }
      return {
        channel: channelId,
        accountHandle: fromNumber,
        credentials: {
          mode: "live",
          accountSid: trimmed.accountSid,
          authToken: trimmed.authToken,
          fromNumber,
        },
      };
    }
    case "x": {
      if (!trimmed.accessToken || !trimmed.selfUserId || !trimmed.selfHandle) {
        throw new Error("Access token, user id, and handle are required");
      }
      return {
        channel: "x",
        accountHandle: trimmed.selfHandle,
        credentials: {
          mode: "live",
          accessToken: trimmed.accessToken,
          selfUserId: trimmed.selfUserId,
          selfHandle: trimmed.selfHandle,
        },
      };
    }
    default:
      throw new Error(`Channel ${channelId} does not use credential connect`);
  }
}

/** Asana PAT stored as owner integration row (not a Channel enum value). */
export function buildAsanaIntegrationPayload(values: Record<string, string>): {
  channel: Channel;
  accountHandle: string;
  credentials: Record<string, string>;
} {
  const pat = values.pat?.trim();
  if (!pat) throw new Error("Asana personal access token is required");
  return {
    channel: "email",
    accountHandle: "__asana__",
    credentials: { mode: "integration", asanaPat: pat },
  };
}
