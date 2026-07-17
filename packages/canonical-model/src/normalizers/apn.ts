import { entityIdSchema } from '@oracle/contracts/ids';

import { normalizeText, sha256Utf8 } from './core.js';

export function normalizeSantaClaraApn(rawApn: string): string {
  const compact = normalizeText(rawApn, 'apn')
    .toUpperCase()
    .replace(/[\s._/-]+/gu, '');
  if (!/^\d{8}$/u.test(compact)) {
    throw new TypeError('Santa Clara APN must contain exactly eight digits');
  }
  return `${compact.slice(0, 3)}-${compact.slice(3, 5)}-${compact.slice(5)}`;
}

export function santaClaraPropertyId(normalizedApn: string) {
  const apn = normalizeSantaClaraApn(normalizedApn);
  return entityIdSchema.parse(`sc:entity:property:${sha256Utf8(`santa-clara-ca|apn|${apn}`)}`);
}
