import { STARBUCKS_WIKIDATA_ID } from './constants.js';
import type {
  OvertureBrand,
  OvertureCategories,
  OvertureNames,
  StarbucksMatchEvidence,
} from './types.js';

const STARBUCKS_NAME = /^starbucks(?:\s+coffee)?$/iu;
const COFFEE_CATEGORIES = new Set(['coffee_shop', 'cafe', 'coffee_roastery']);

function normalized(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function nameMatches(value: string | null | undefined): boolean {
  return value !== undefined && value !== null && STARBUCKS_NAME.test(normalized(value));
}

export function classifyStarbucksMatch(input: {
  readonly names: OvertureNames;
  readonly categories: OvertureCategories;
  readonly brand: OvertureBrand | null;
}): StarbucksMatchEvidence {
  const wikidataMatched = input.brand?.wikidata === STARBUCKS_WIKIDATA_ID;
  const brandNameMatched = nameMatches(input.brand?.names?.primary);
  const primaryNameMatched = nameMatches(input.names.primary);
  const coffeeCategoryMatched = [input.categories.primary, ...input.categories.alternate].some(
    (category) => COFFEE_CATEGORIES.has(normalized(category)),
  );
  const mode = wikidataMatched
    ? 'wikidata_exact'
    : brandNameMatched
      ? 'brand_name_exact'
      : primaryNameMatched && coffeeCategoryMatched
        ? 'category_name_combination'
        : primaryNameMatched
          ? 'primary_name_exact'
          : 'no_match';
  const matchedValues = [
    wikidataMatched ? STARBUCKS_WIKIDATA_ID : null,
    brandNameMatched ? (input.brand?.names?.primary ?? null) : null,
    primaryNameMatched ? input.names.primary : null,
    coffeeCategoryMatched ? input.categories.primary : null,
  ].filter((value): value is string => value !== null);
  return Object.freeze({
    mode,
    wikidataMatched,
    brandNameMatched,
    primaryNameMatched,
    coffeeCategoryMatched,
    matchedValues: Object.freeze([...new Set(matchedValues)]),
  });
}
