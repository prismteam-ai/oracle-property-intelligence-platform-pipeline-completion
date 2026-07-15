declare module "mailparser" {
  export function simpleParser(source: Buffer | string): Promise<{
    from?: { value: { address?: string; name?: string }[] };
    to?: { value: { address?: string; name?: string }[] };
    subject?: string;
    text?: string;
    date?: Date;
    messageId?: string;
    references?: string | string[];
    inReplyTo?: string;
  }>;
}
