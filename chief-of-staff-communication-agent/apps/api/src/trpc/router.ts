import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  addKnowledge,
  dashboardMetrics,
  deleteConnectorToken,
  getMessage,
  getOwnerAsanaPat,
  getRecommendation,
  listAsanaLinks,
  listConnectorTokens,
  listKnowledge,
  listMessages,
  listMessagesBySender,
  listPendingDrafts,
  listPeople,
  listTopicMessages,
  searchRag,
  upsertConnectorToken,
} from "@indeedee/db";
import {
  CHANNEL_CATALOG,
  buildAsanaIntegrationPayload,
  buildConnectPayload,
  type Channel,
} from "@indeedee/shared";
import { redraftWithContext } from "@indeedee/brain";
import { testAsanaConnection, testChannelConnection } from "@indeedee/connectors";
import { runSync, seedDemoConnections, sendApprovedDraft } from "../services/runtime.js";

export interface ApiContext {
  ownerId: string;
  role: "owner" | "viewer";
}

const t = initTRPC.context<ApiContext>().create();

const ownerProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.role !== "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Owner role required" });
  }
  return next({ ctx });
});

export const appRouter = t.router({
  health: t.procedure.query(() => ({ ok: true as const, service: "indeedee-agent" })),

  communications: t.router({
    list: t.procedure.query(async ({ ctx }) => {
      const messages = await listMessages(ctx.ownerId);
      const enriched = await Promise.all(
        messages.map(async (m) => ({
          ...m,
          recommendation: await getRecommendation(ctx.ownerId, m.id),
        })),
      );
      return { ownerId: ctx.ownerId, messages: enriched };
    }),
    listPending: t.procedure.query(async ({ ctx }) => ({
      ownerId: ctx.ownerId,
      messages: await listMessages(ctx.ownerId, { pendingOnly: true }),
    })),
    get: t.procedure.input(z.object({ messageId: z.string() })).query(async ({ ctx, input }) => {
      const message = await getMessage(ctx.ownerId, input.messageId);
      if (!message) throw new TRPCError({ code: "NOT_FOUND" });
      const recommendation = await getRecommendation(ctx.ownerId, input.messageId);
      const drafts = (await listPendingDrafts(ctx.ownerId)).filter(
        (d) => d.messageId === input.messageId,
      );
      const asanaLinks = await listAsanaLinks(ctx.ownerId, input.messageId);
      const related =
        recommendation?.topicKey ?
          await listTopicMessages(ctx.ownerId, recommendation.topicKey)
        : [];
      return {
        ownerId: ctx.ownerId,
        message,
        recommendation,
        draft: drafts[0] ?? null,
        asanaLinks,
        related,
      };
    }),
  }),

  approvals: t.router({
    list: t.procedure.query(async ({ ctx }) => ({
      ownerId: ctx.ownerId,
      drafts: await listPendingDrafts(ctx.ownerId),
    })),
    approve: ownerProcedure
      .input(z.object({ draftId: z.string(), editedBody: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const result = await sendApprovedDraft(ctx.ownerId, input.draftId, input.editedBody);
        return { ownerId: ctx.ownerId, status: "sent" as const, ...result };
      }),
    reject: ownerProcedure
      .input(z.object({ draftId: z.string(), note: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const { updateDraftStatus } = await import("@indeedee/db");
        await updateDraftStatus(ctx.ownerId, input.draftId, "rejected");
        return { ownerId: ctx.ownerId, draftId: input.draftId, status: "rejected" as const };
      }),
    provideContext: ownerProcedure
      .input(z.object({ messageId: z.string(), context: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        await redraftWithContext(ctx.ownerId, input.messageId, input.context);
        return { ownerId: ctx.ownerId, messageId: input.messageId, status: "redrafted" as const };
      }),
  }),

  connectors: t.router({
    list: t.procedure.query(async ({ ctx }) => ({
      ownerId: ctx.ownerId,
      channels: await listConnectorTokens(ctx.ownerId),
    })),
    catalog: t.procedure.query(async ({ ctx }) => {
      const connected = await listConnectorTokens(ctx.ownerId);
      const asanaPat = await getOwnerAsanaPat(ctx.ownerId);
      const byChannel = connected.reduce<Record<string, typeof connected>>((acc, row) => {
        (acc[row.channel] ??= []).push(row);
        return acc;
      }, {});
      return {
        ownerId: ctx.ownerId,
        googleOAuthConfigured: Boolean(
          process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
        ),
        asanaConnected: Boolean(asanaPat || process.env.ASANA_PAT),
        channels: CHANNEL_CATALOG.map((entry) => ({
          ...entry,
          connections:
            entry.id === "asana"
              ? asanaPat || process.env.ASANA_PAT
                ? [{ accountHandle: "asana", connectedAt: "" }]
                : []
              : (byChannel[entry.id] ?? []),
        })),
      };
    }),
    connect: ownerProcedure
      .input(
        z.object({
          channel: z.enum(["gmail", "email", "sms", "whatsapp", "x", "linkedin"]),
          accountHandle: z.string().min(1),
          credentials: z.record(z.string()).default({ mode: "demo" }),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.channel === "linkedin") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "LinkedIn has no compliant personal-messaging API — not available",
          });
        }
        await upsertConnectorToken({
          ownerId: ctx.ownerId,
          channel: input.channel,
          accountHandle: input.accountHandle,
          credentials: input.credentials,
        });
        return { ownerId: ctx.ownerId, channel: input.channel, status: "connected" as const };
      }),
    connectForm: ownerProcedure
      .input(
        z.object({
          channelId: z.string(),
          values: z.record(z.string()),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.channelId === "asana") {
          const payload = buildAsanaIntegrationPayload(input.values);
          await upsertConnectorToken({ ownerId: ctx.ownerId, ...payload });
          return { ownerId: ctx.ownerId, channel: "asana" as const, status: "connected" as const };
        }
        const payload = buildConnectPayload(input.channelId, input.values);
        if (payload.channel === "linkedin") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "LinkedIn not available" });
        }
        await upsertConnectorToken({ ownerId: ctx.ownerId, ...payload });
        return { ownerId: ctx.ownerId, channel: payload.channel, status: "connected" as const };
      }),
    disconnect: ownerProcedure
      .input(
        z.object({
          channel: z.enum(["gmail", "email", "sms", "whatsapp", "x"]),
          accountHandle: z.string().min(1),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const ok = await deleteConnectorToken(ctx.ownerId, input.channel, input.accountHandle);
        if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });
        return { ownerId: ctx.ownerId, status: "disconnected" as const };
      }),
    disconnectAsana: ownerProcedure.mutation(async ({ ctx }) => {
      await deleteConnectorToken(ctx.ownerId, "email", "__asana__");
      return { ownerId: ctx.ownerId, status: "disconnected" as const };
    }),
    test: ownerProcedure
      .input(
        z.object({
          channelId: z.string(),
          accountHandle: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.channelId === "linkedin") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "LinkedIn has no compliant personal-messaging API",
          });
        }
        if (input.channelId === "asana") {
          const pat =
            (await getOwnerAsanaPat(ctx.ownerId)) ?? process.env.ASANA_PAT ?? "";
          if (!pat) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Asana not connected" });
          }
          const result = await testAsanaConnection(pat);
          return { ownerId: ctx.ownerId, channelId: "asana" as const, ...result };
        }

        const channel = input.channelId as Channel;
        const { getConnectorCredentials } = await import("@indeedee/db");
        const tokens = (await listConnectorTokens(ctx.ownerId)).filter(
          (t) => t.channel === channel,
        );
        const accountHandle = input.accountHandle ?? tokens[0]?.accountHandle;
        if (!accountHandle) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Channel not connected" });
        }
        const credentials =
          (await getConnectorCredentials(ctx.ownerId, channel, accountHandle)) ?? {
            mode: "demo",
          };
        const result = await testChannelConnection(channel, accountHandle, credentials);
        return { ownerId: ctx.ownerId, channelId: channel, accountHandle, ...result };
      }),
    seedDemo: ownerProcedure.mutation(async ({ ctx }) => seedDemoConnections(ctx.ownerId)),
  }),

  knowledge: t.router({
    list: t.procedure.query(async ({ ctx }) => ({
      ownerId: ctx.ownerId,
      items: await listKnowledge(ctx.ownerId),
    })),
    add: ownerProcedure
      .input(
        z.object({
          kind: z.enum(["preference", "org"]),
          title: z.string(),
          body: z.string().min(1),
        }),
      )
      .mutation(async ({ ctx, input }) => ({
        ownerId: ctx.ownerId,
        id: await addKnowledge(ctx.ownerId, input.kind, input.title, input.body),
      })),
  }),

  people: t.router({
    list: t.procedure.query(async ({ ctx }) => ({
      ownerId: ctx.ownerId,
      people: await listPeople(ctx.ownerId),
    })),
    thread: t.procedure
      .input(z.object({ handle: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const messages = await listMessagesBySender(ctx.ownerId, input.handle);
        const enriched = await Promise.all(
          messages.map(async (m) => ({
            ...m,
            recommendation: await getRecommendation(ctx.ownerId, m.id),
          })),
        );
        return { ownerId: ctx.ownerId, handle: input.handle, messages: enriched };
      }),
  }),

  metrics: t.router({
    dashboard: t.procedure.query(async ({ ctx }) => ({
      ownerId: ctx.ownerId,
      ...(await dashboardMetrics(ctx.ownerId)),
    })),
  }),

  rag: t.router({
    search: t.procedure
      .input(z.object({ query: z.string(), topK: z.number().int().min(1).max(20).default(5) }))
      .query(async ({ ctx, input }) => ({
        ownerId: ctx.ownerId,
        query: input.query,
        hits: await searchRag(ctx.ownerId, input.query, input.topK),
      })),
  }),

  sync: ownerProcedure.mutation(async ({ ctx }) => {
    const result = await runSync(ctx.ownerId);
    return { ownerId: ctx.ownerId, status: "completed" as const, ...result };
  }),
});

export type AppRouter = typeof appRouter;
