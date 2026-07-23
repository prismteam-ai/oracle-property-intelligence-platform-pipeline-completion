import { z } from 'zod';

export const visibilitySchema = z.enum([
  'public',
  'authenticated',
  'restricted',
  'prohibited_public',
]);

export type Visibility = z.infer<typeof visibilitySchema>;

export const publicVisibilitySchema = z.literal('public');
export type PublicVisibility = z.infer<typeof publicVisibilitySchema>;

export const visibilityCountsSchema = z.strictObject({
  public: z.number().int().nonnegative(),
  authenticated: z.number().int().nonnegative(),
  restricted: z.number().int().nonnegative(),
  prohibited_public: z.number().int().nonnegative(),
});

export type VisibilityCounts = z.infer<typeof visibilityCountsSchema>;
