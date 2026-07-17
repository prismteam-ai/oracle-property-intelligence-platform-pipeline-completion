import { z } from 'zod';

import { nonEmptyStringSchema } from '../foundation.js';
import { entityIdSchemaFor } from '../ids.js';
import { geoGeometrySchema, geoPointSchema } from './geospatial.js';
import { canonicalEntityMetadataSchema } from './lineage.js';

const addressIdSchema = entityIdSchemaFor('address');
const propertyIdSchema = entityIdSchemaFor('property');
const propertyUnitIdSchema = entityIdSchemaFor('property-unit');

export const addressSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: addressIdSchema,
  entityKind: z.literal('address'),
  line1: nonEmptyStringSchema,
  line2: nonEmptyStringSchema.nullable(),
  locality: nonEmptyStringSchema,
  region: z.literal('CA'),
  postalCode: z.string().regex(/^\d{5}(?:-\d{4})?$/u),
  country: z.literal('US'),
  normalized: nonEmptyStringSchema,
  location: geoPointSchema.nullable(),
});

export type Address = z.infer<typeof addressSchema>;

export const propertySchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: propertyIdSchema,
  entityKind: z.literal('property'),
  county: z.literal('Santa Clara'),
  state: z.literal('CA'),
  apn: z.string().regex(/^[A-Z0-9-]{5,32}$/u, 'Expected a normalized Santa Clara APN'),
  jurisdiction: nonEmptyStringSchema,
  primaryAddressId: addressIdSchema.nullable(),
  unitIds: z.array(propertyUnitIdSchema),
  parcelGeometry: geoGeometrySchema.nullable(),
  landAreaSquareMeters: z.number().nonnegative().nullable(),
});

export type Property = z.infer<typeof propertySchema>;

export const propertyUnitSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: propertyUnitIdSchema,
  entityKind: z.literal('property-unit'),
  propertyId: propertyIdSchema,
  unitIdentifier: nonEmptyStringSchema,
  assessmentIdentifier: nonEmptyStringSchema.nullable(),
  addressId: addressIdSchema.nullable(),
});

export type PropertyUnit = z.infer<typeof propertyUnitSchema>;
