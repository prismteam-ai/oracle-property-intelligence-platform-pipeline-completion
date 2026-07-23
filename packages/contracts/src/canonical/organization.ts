import { z } from 'zod';

import { isoDateTimeSchema, nonEmptyStringSchema } from '../foundation.js';
import { entityIdSchemaFor } from '../ids.js';
import { supportStateSchema } from '../pipeline.js';
import { canonicalEntityMetadataSchema } from './lineage.js';

const addressIdSchema = entityIdSchemaFor('address');
const businessIdSchema = entityIdSchemaFor('business');
const contractorIdSchema = entityIdSchemaFor('contractor');
const ownershipEventIdSchema = entityIdSchemaFor('ownership-event');
const ownershipInterestIdSchema = entityIdSchemaFor('ownership-interest');
const partyIdSchema = entityIdSchemaFor('party');
const propertyIdSchema = entityIdSchemaFor('property');
const propertyUnitIdSchema = entityIdSchemaFor('property-unit');

export const partyIdentifierSchema = z.strictObject({
  scheme: nonEmptyStringSchema,
  value: nonEmptyStringSchema,
});

export type PartyIdentifier = z.infer<typeof partyIdentifierSchema>;

export const partySchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: partyIdSchema,
  entityKind: z.literal('party'),
  partyKind: z.enum(['person', 'organization', 'unknown']),
  displayName: nonEmptyStringSchema,
  identifiers: z.array(partyIdentifierSchema),
  addressIds: z.array(addressIdSchema),
});

export type Party = z.infer<typeof partySchema>;

export const ownershipInterestSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: ownershipInterestIdSchema,
  entityKind: z.literal('ownership-interest'),
  propertyId: propertyIdSchema,
  propertyUnitId: propertyUnitIdSchema.nullable(),
  partyId: partyIdSchema,
  interestType: nonEmptyStringSchema,
  share: z.number().min(0).max(1).nullable(),
  effectiveFrom: isoDateTimeSchema,
  effectiveTo: isoDateTimeSchema.nullable(),
  supportState: supportStateSchema,
});

export type OwnershipInterest = z.infer<typeof ownershipInterestSchema>;

export const ownershipEventSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: ownershipEventIdSchema,
  entityKind: z.literal('ownership-event'),
  propertyId: propertyIdSchema,
  propertyUnitId: propertyUnitIdSchema.nullable(),
  eventType: z.enum(['transfer', 'interest_started', 'interest_ended', 'correction', 'unknown']),
  recordedDocumentId: nonEmptyStringSchema.nullable(),
  occurredAt: isoDateTimeSchema,
  grantorPartyIds: z.array(partyIdSchema),
  granteePartyIds: z.array(partyIdSchema),
  supportState: supportStateSchema,
});

export type OwnershipEvent = z.infer<typeof ownershipEventSchema>;

export const contractorSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: contractorIdSchema,
  entityKind: z.literal('contractor'),
  licenseNumber: nonEmptyStringSchema,
  legalName: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  classifications: z.array(nonEmptyStringSchema),
  businessIds: z.array(businessIdSchema),
  addressIds: z.array(addressIdSchema),
});

export type Contractor = z.infer<typeof contractorSchema>;

export const businessSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: businessIdSchema,
  entityKind: z.literal('business'),
  jurisdiction: nonEmptyStringSchema,
  entityNumber: z.string().regex(/^[A-Z0-9-]{5,32}$/u),
  legalName: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  businessType: nonEmptyStringSchema,
  addressIds: z.array(addressIdSchema),
});

export type Business = z.infer<typeof businessSchema>;
