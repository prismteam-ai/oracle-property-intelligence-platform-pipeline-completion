import type { Message, Recommendation } from "@indeedee/shared";

const UNCERTAIN = /\b(confidential|legal|term sheet|unknown|which project)\b/i;

export interface RuleInput {
  message: Message;
  ragHits: Array<{ sourceType: string; title?: string; text: string }>;
  prefs: Array<{ body: string }>;
  style: string[];
}

export interface RuleOutput {
  action: Recommendation["action"];
  rationale: string;
  needsContext: boolean;
  contextQuestion?: string;
  topicKey?: string;
  taskTitle?: string;
  taskDetail?: string;
  draftBody?: string;
}

export function inferTopicKey(message: Message): string | undefined {
  const handle = message.sender.handle.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const subject = (message.subject ?? message.bodyText.slice(0, 40))
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();
  return `${handle}:${subject}`.slice(0, 120);
}

export function recommendWithRules(input: RuleInput): RuleOutput {
  const { message, ragHits, prefs, style } = input;
  let action: Recommendation["action"] = "reply";
  let needsContext = false;
  let contextQuestion: string | undefined;
  let taskTitle: string | undefined;
  let draftBody: string | undefined;

  if (UNCERTAIN.test(message.bodyText) && ragHits.length === 0) {
    action = "needs_context";
    needsContext = true;
    contextQuestion = "Which project or context should I use for this reply?";
  } else if (/create a task|follow up task|remind me/i.test(message.bodyText)) {
    action = "create_task";
    taskTitle = extractTaskTitle(message.bodyText);
  } else if (/fyi|no action needed|for your records/i.test(message.bodyText)) {
    action = "archive";
  }

  const rationale = buildRationale(message, ragHits, action);
  if (action === "reply" || action === "create_task") {
    draftBody = buildDraft(message, style, prefs, ragHits);
  }

  return {
    action,
    rationale,
    needsContext,
    contextQuestion,
    topicKey: inferTopicKey(message),
    taskTitle,
    taskDetail: message.bodyText.slice(0, 500),
    draftBody,
  };
}

function extractTaskTitle(body: string): string {
  const quoted = body.match(/"([^"]+)"/)?.[1];
  if (quoted) return quoted.slice(0, 120);
  return body.split(/[.!?]/)[0]?.slice(0, 120) ?? "Follow up";
}

function buildRationale(
  message: Message,
  ragHits: Array<{ sourceType: string; title?: string }>,
  action: string,
): string {
  const sources = ragHits.map((h) => h.sourceType).join(", ") || "thread only";
  return `Suggested ${action} for ${message.channel} from ${message.sender.displayName ?? message.sender.handle} using context: ${sources}.`;
}

function buildDraft(
  message: Message,
  style: string[],
  prefs: Array<{ body: string }>,
  ragHits: Array<{ text: string }>,
): string {
  const signoff = style[0]?.includes("Best") ? "Best," : "Thanks,";
  const prefLine = prefs[0]?.body ? `\n(Preference: ${prefs[0].body})` : "";
  const contextLine = ragHits[0]?.text ? `\nRe: ${ragHits[0].text.slice(0, 120)}` : "";
  return (
    `Hi ${message.sender.displayName ?? message.sender.handle},\n\n` +
    `Thanks for your note about "${message.subject ?? message.bodyText.slice(0, 60)}". ` +
    `I'll follow up shortly with the next step.${contextLine}${prefLine}\n\n${signoff}\nExecutive`
  );
}
