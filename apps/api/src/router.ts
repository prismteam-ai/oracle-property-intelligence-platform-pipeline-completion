import { initTRPC } from '@trpc/server';

import { FOUNDATION_STATUS } from '@oracle/contracts';

const trpc = initTRPC.create();

export const appRouter = trpc.router({
  foundation: trpc.router({
    status: trpc.procedure.query(() => FOUNDATION_STATUS),
  }),
});

export type AppRouter = typeof appRouter;
