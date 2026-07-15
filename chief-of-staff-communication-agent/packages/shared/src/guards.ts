export class ApprovalRequiredError extends Error {
  constructor(message = "Draft must be approved before send") {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

export type DraftSendStatus = "pending_approval" | "approved" | "rejected" | "sent";

/** AC-20: no send without explicit approval. */
export function assertSendAllowed(status: DraftSendStatus): void {
  if (status !== "approved") {
    throw new ApprovalRequiredError();
  }
}

const SLA_SECONDS = 5 * 60;

/** AC-22: message is overdue when still pending past five minutes. */
export function isOverdue(pendingSince: Date, now = new Date()): boolean {
  return now.getTime() - pendingSince.getTime() > SLA_SECONDS * 1000;
}

/** AC-22: dashboard overdue count helper. */
export function countOverdue(
  pendingMessages: Array<{ sentAt: string; answeredStatus: string }>,
  now = new Date(),
): number {
  return pendingMessages.filter((m) => {
    if (m.answeredStatus !== "pending") return false;
    return isOverdue(new Date(m.sentAt), now);
  }).length;
}
