/**
 * `EconomyApi` (docs/design/economy.md section 5, ADR-007), registered under `ECONOMY_SERVICE`.
 *
 * Ownership rule (ARCHITECTURE.md section 6.2): `handle.slice()` is a mutation declaration, so only
 * `clearConsumerMarket` and `buyRaw` call it; every read goes through `handle.state().economy`.
 *
 * Content binding: the demand response needs the product's elasticity and `pricing.maxCapture`
 * from `scenario.content`, which the engine's `ServiceHandle` does not expose (it has no
 * `scenario()`), and the design forbids copying content into the slice. Until the engine adds
 * `ServiceHandle.scenario()`, the economy system binds the immutable content into the service at
 * the start of every `macro` phase through the internal `bindContent` method (the phase runs before
 * any `production`/`market` caller, on fresh and on restored worlds alike). Content-dependent
 * methods called before the first `macro` throw `InvariantError('economy.content_unbound')`; the
 * UI/AI preview path uses the pure `expectedCaptureFor(state, content, ...)` instead.
 */
import { createServiceKey, type ServiceHandle, type ServiceKey } from '../engine/index.js';
import {
  InvariantError,
  type CityId,
  type CompanyId,
  type EconomyState,
  type MarketId,
  type Money,
  type ProductId,
  type Quantity,
  type StoreId,
} from '../schema/index.js';
import {
  clearConsumerMarketIn,
  expectedCaptureFor,
  marketOfCityIn,
  productMarketOf,
  quoteRawFrom,
  recordRawPurchase,
  type ReadonlyContent,
} from './state.js';

export interface MarketOffer {
  sellerId: CompanyId;
  storeId: StoreId;
  productId: ProductId;
  /** >= 1. */
  price: Money;
  /** Units on offer today (stock on shelf). */
  quantity: Quantity;
  /** Placeholder, 0 in M1 (ignored). */
  quality: number;
  /** Placeholder, 0 in M1 (ignored). */
  brand: number;
}

export interface MarketClearing {
  /** Aligned with the offers; `sold[i] <= offers[i].quantity`. */
  sold: readonly Quantity[];
  /** Today's reference price. */
  referencePrice: Money;
  /** `demandRemaining` before this clearing. */
  demandBefore: Quantity;
  demandAfter: Quantity;
}

export interface RawQuote {
  productId: ProductId;
  quantity: Quantity;
  unitPrice: Money;
  /** `mulMoney(unitPrice, quantity)`. */
  total: Money;
}

export interface EconomyApi {
  // ---- reads (via handle.state(); never handle.slice()) ----
  policyRate(): number;
  priceIndex(): number;
  marketOfCity(cityId: CityId): MarketId | null;
  /** Today's reference price. `InvariantError('economy.unknown_market')` if unknown. */
  referencePrice(marketId: MarketId, productId: ProductId): Money;
  /** Baseline demand left today (decremented by clearings). */
  demandRemaining(marketId: MarketId, productId: ProductId): Quantity;
  /** `floor(demandRemaining x g(price / referencePrice))`; preview, no side effects. */
  expectedCapture(marketId: MarketId, productId: ProductId, price: Money): Quantity;
  /** Today's commodity quote. `InvariantError('economy.unknown_commodity')` if unknown. */
  quoteRaw(productId: ProductId, quantity: Quantity): RawQuote;

  // ---- writes (via handle.slice()); legal in `market` (clear) / `production` (buyRaw) ----
  /**
   * Clears every store's offer for one (market, product) against today's remaining demand; called
   * once per (market, product) per tick by retail. Records the tallies that set tomorrow's price.
   * Emits nothing (retail emits `store.sold`).
   */
  clearConsumerMarket(
    marketId: MarketId,
    productId: ProductId,
    offers: readonly MarketOffer[],
  ): MarketClearing;
  /**
   * Records a raw-material purchase from the NPC source (unlimited quantity in M1) and emits
   * `commodity.purchased`. Returns the quote; the CALLER posts `inventoryPurchase(total)`.
   */
  buyRaw(buyerId: CompanyId, productId: ProductId, quantity: Quantity): RawQuote;
}

/** Internal surface the economy system uses on its own service; not exported from the barrel. */
export interface EconomyApiInternal extends EconomyApi {
  bindContent(content: ReadonlyContent): void;
}

export const ECONOMY_SERVICE: ServiceKey<EconomyApi> = createServiceKey<EconomyApi>('economy');

export function createEconomyApi(handle: ServiceHandle<EconomyState>): EconomyApiInternal {
  let bound: ReadonlyContent | null = null;
  const content = (): ReadonlyContent => {
    if (bound === null) {
      throw new InvariantError(
        'economy.content_unbound',
        'EconomyApi used before the first macro phase bound the scenario content',
      );
    }
    return bound;
  };
  /** Read-only view for queries; never `handle.slice()`. */
  const view = () => handle.state().economy;

  return {
    bindContent(c) {
      bound = c;
    },
    policyRate() {
      return view().macro.policyRate;
    },
    priceIndex() {
      return view().macro.priceIndex;
    },
    marketOfCity(cityId) {
      return marketOfCityIn(view(), cityId);
    },
    referencePrice(marketId, productId) {
      return productMarketOf(view(), marketId, productId).referencePrice;
    },
    demandRemaining(marketId, productId) {
      return productMarketOf(view(), marketId, productId).demandRemaining;
    },
    expectedCapture(marketId, productId, price) {
      return expectedCaptureFor(view(), content(), marketId, productId, price);
    },
    quoteRaw(productId, quantity) {
      return quoteRawFrom(view(), productId, quantity);
    },
    clearConsumerMarket(marketId, productId, offers) {
      return clearConsumerMarketIn(handle.slice(), content(), marketId, productId, offers);
    },
    buyRaw(buyerId, productId, quantity) {
      const quote = recordRawPurchase(handle.slice(), productId, quantity);
      handle.emit({
        type: 'commodity.purchased',
        payload: {
          companyId: buyerId,
          productId,
          quantity,
          unitPrice: quote.unitPrice,
          total: quote.total,
        },
      });
      return quote;
    },
  };
}
