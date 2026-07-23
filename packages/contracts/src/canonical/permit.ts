import { z } from 'zod';

import { isoDateTimeSchema, nonEmptyStringSchema } from '../foundation.js';
import { entityIdSchemaFor } from '../ids.js';
import { canonicalEntityMetadataSchema } from './lineage.js';

const propertyIdSchema = entityIdSchemaFor('property');
const propertyUnitIdSchema = entityIdSchemaFor('property-unit');
const permitIdSchema = entityIdSchemaFor('permit');
const contractorIdSchema = entityIdSchemaFor('contractor');

export const permitPropertyLinkSchema = z.strictObject({
  propertyId: propertyIdSchema,
  propertyUnitId: propertyUnitIdSchema.nullable(),
  method: z.enum(['source_identifier', 'normalized_identifier', 'candidate', 'manual']),
  score: z.number().min(0).max(1),
});

export type PermitPropertyLink = z.infer<typeof permitPropertyLinkSchema>;

export const permitSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: permitIdSchema,
  entityKind: z.literal('permit'),
  permitNumber: nonEmptyStringSchema,
  jurisdiction: nonEmptyStringSchema,
  permitType: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  statusAsOf: isoDateTimeSchema,
  description: nonEmptyStringSchema.nullable(),
  issuedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  propertyLinks: z.array(permitPropertyLinkSchema),
  contractorIds: z.array(contractorIdSchema),
});

export type Permit = z.infer<typeof permitSchema>;
