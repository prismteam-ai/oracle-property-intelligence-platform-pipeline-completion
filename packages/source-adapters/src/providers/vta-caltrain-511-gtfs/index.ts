import { createStaticGtfsAdapter, type StaticGtfsAdapter } from './adapter.js';
import { validateTransitFeedFamilyConfig } from './family.js';
import { CALTRAIN_2026_06_10_SNAPSHOT, VTA_2026_07_15_SNAPSHOT } from './snapshots.js';
import type { TransitFeedFamilyConfig, TransitOperator } from './types.js';

export {
  compareTransitSnapshots,
  selectTransitSnapshot,
  validateTransitFeedFamilyConfig,
} from './family.js';
export { decodeGtfsZip, parseGtfsCsv, validateGtfsFeed } from './gtfs.js';
export { createCanonicalTransitMutations, normalizeTransitSnapshot } from './normalize.js';
export { CALTRAIN_2026_06_10_SNAPSHOT, VTA_2026_07_15_SNAPSHOT } from './snapshots.js';
export type * from './types.js';

export function createVtaCurrentGtfsAdapter(): StaticGtfsAdapter {
  return createStaticGtfsAdapter(VTA_2026_07_15_SNAPSHOT);
}

export function createCaltrainCurrentGtfsAdapter(): StaticGtfsAdapter {
  return createStaticGtfsAdapter(CALTRAIN_2026_06_10_SNAPSHOT);
}

export interface TransitFeedFamily {
  readonly vta: StaticGtfsAdapter;
  readonly caltrain: StaticGtfsAdapter;
  readonly fallback511: Readonly<Partial<Record<TransitOperator, StaticGtfsAdapter>>>;
}

/**
 * Family construction requires both direct operator feeds. 511 can only be
 * added as an injected-auth fallback/cross-check and therefore cannot become
 * the lane's sole transit dependency.
 */
export function createTransitFeedFamily(config: TransitFeedFamilyConfig): TransitFeedFamily {
  validateTransitFeedFamilyConfig(config);
  const fallback: Partial<Record<TransitOperator, StaticGtfsAdapter>> = {};
  if (config.fallback511?.vta !== undefined) {
    fallback.vta = createStaticGtfsAdapter(config.fallback511.vta);
  }
  if (config.fallback511?.caltrain !== undefined) {
    fallback.caltrain = createStaticGtfsAdapter(config.fallback511.caltrain);
  }
  return Object.freeze({
    vta: createStaticGtfsAdapter(config.vta),
    caltrain: createStaticGtfsAdapter(config.caltrain),
    fallback511: Object.freeze(fallback),
  });
}
