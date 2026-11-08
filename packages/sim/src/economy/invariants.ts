/**
 * Economy invariant checker for tests and sim-tests (docs/design/economy.md section 8). Read-only.
 *
 * With `content` the level bands use the scenario's `kappa`s and the sold bound uses `maxCapture`;
 * without it the checker falls back to the widest admissible tunables (`kappa <= 0.5`,
 * `maxCapture <= 3`), so a caller that only has `WorldState` still catches gross violations.
 */
import type { DeepReadonly } from '../engine/index.js';
import type { ContentPack, EconomyState, MarketId, ProductId } from '../schema/index.js';

export type EconomyInvariantCode =
  | 'market.level_out_of_band'
  | 'market.ema_out_of_range'
  | 'market.reference_price'
  | 'market.demand_remaining'
  | 'market.sold_exceeds_demand'
  | 'market.tally_invalid'
  | 'commodity.level_out_of_band'
  | 'commodity.unit_price'
  | 'commodity.tally_invalid'
  | 'macro.price_index'
  | 'macro.policy_rate'
  | 'macro.demand_index'
  | 'economy.non_finite';

export interface EconomyInvariantViolation {
  code: EconomyInvariantCode;
  marketId?: MarketId;
  productId?: ProductId;
  message: string;
}

/** Widest admissible tunables (schema ranges), used when no content is supplied. */
const MAX_KAPPA = 0.5;
const MAX_CAPTURE = 3;
/** Slack for the band check (economy.md 8.1); the implementation clamps, so 0 would also pass. */
const BAND_EPSILON = 1e-9;

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isNonNegInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export function checkEconomyInvariants(
  state: { readonly economy: DeepReadonly<EconomyState> },
  content?: DeepReadonly<ContentPack>,
): EconomyInvariantViolation[] {
  const out: EconomyInvariantViolation[] = [];
  const economy = state.economy;
  const kappa = content?.economy.pricing.kappa ?? MAX_KAPPA;
  const maxCapture = content?.economy.pricing.maxCapture ?? MAX_CAPTURE;

  const macro = economy.macro;
  if (!isFiniteNumber(macro.priceIndex) || macro.priceIndex <= 0) {
    out.push({ code: 'macro.price_index', message: `priceIndex ${String(macro.priceIndex)}` });
  }
  if (!isFiniteNumber(macro.policyRate) || macro.policyRate < 0 || macro.policyRate > 1) {
    out.push({ code: 'macro.policy_rate', message: `policyRate ${String(macro.policyRate)}` });
  }
  if (!isFiniteNumber(macro.demandIndex) || macro.demandIndex <= 0) {
    out.push({ code: 'macro.demand_index', message: `demandIndex ${String(macro.demandIndex)}` });
  }

  for (const marketId of Object.keys(economy.markets).sort() as MarketId[]) {
    const market = economy.markets[marketId];
    if (market === undefined) continue;
    for (const productId of Object.keys(market.products).sort() as ProductId[]) {
      const pm = market.products[productId];
      if (pm === undefined) continue;
      const where = `${marketId}/${productId}`;
      const at = { marketId, productId };
      const floats = [pm.level, pm.imbalanceEma, pm.offeredToday, pm.lastOffered];
      if (!floats.every(isFiniteNumber)) {
        out.push({ ...at, code: 'economy.non_finite', message: `${where}: non-finite float` });
        continue;
      }
      if (pm.level < 1 - kappa - BAND_EPSILON || pm.level > 1 + kappa + BAND_EPSILON) {
        out.push({
          ...at,
          code: 'market.level_out_of_band',
          message: `${where}: level ${pm.level} outside [${1 - kappa}, ${1 + kappa}]`,
        });
      }
      if (Math.abs(pm.imbalanceEma) > 1) {
        out.push({
          ...at,
          code: 'market.ema_out_of_range',
          message: `${where}: imbalanceEma ${pm.imbalanceEma}`,
        });
      }
      if (!isNonNegInt(pm.referencePrice) || pm.referencePrice < 1) {
        out.push({
          ...at,
          code: 'market.reference_price',
          message: `${where}: referencePrice ${String(pm.referencePrice)}`,
        });
      }
      const tallies = [pm.demandToday, pm.demandRemaining, pm.soldToday, pm.lastDemand, pm.lastSold];
      if (!tallies.every(isNonNegInt) || pm.offeredToday < 0 || pm.lastOffered < 0) {
        out.push({
          ...at,
          code: 'market.tally_invalid',
          message: `${where}: a tally is negative or not an integer`,
        });
        continue;
      }
      if (pm.demandRemaining > pm.demandToday) {
        out.push({
          ...at,
          code: 'market.demand_remaining',
          message: `${where}: demandRemaining ${pm.demandRemaining} > demandToday ${pm.demandToday}`,
        });
      }
      if (pm.soldToday > Math.floor(pm.demandToday * maxCapture)) {
        out.push({
          ...at,
          code: 'market.sold_exceeds_demand',
          message: `${where}: soldToday ${pm.soldToday} > floor(${pm.demandToday} x ${maxCapture})`,
        });
      }
    }
  }

  for (const productId of Object.keys(economy.commodities).sort() as ProductId[]) {
    const cs = economy.commodities[productId];
    if (cs === undefined) continue;
    const kappaC = content?.economy.commodities[productId]?.kappa ?? MAX_KAPPA;
    if (!isFiniteNumber(cs.level) || !isFiniteNumber(cs.volumeEma)) {
      out.push({ productId, code: 'economy.non_finite', message: `${productId}: non-finite float` });
      continue;
    }
    if (cs.level < 1 - kappaC - BAND_EPSILON || cs.level > 1 + kappaC + BAND_EPSILON) {
      out.push({
        productId,
        code: 'commodity.level_out_of_band',
        message: `${productId}: level ${cs.level} outside [${1 - kappaC}, ${1 + kappaC}]`,
      });
    }
    if (!isNonNegInt(cs.unitPrice) || cs.unitPrice < 1) {
      out.push({
        productId,
        code: 'commodity.unit_price',
        message: `${productId}: unitPrice ${String(cs.unitPrice)}`,
      });
    }
    if (!isNonNegInt(cs.purchasedToday) || !isNonNegInt(cs.lastPurchased)) {
      out.push({
        productId,
        code: 'commodity.tally_invalid',
        message: `${productId}: purchase tally invalid`,
      });
    }
  }
  return out;
}
