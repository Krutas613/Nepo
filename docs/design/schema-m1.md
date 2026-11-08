# Schema request: Milestone 1 (REQ-002, consolidated)

Requested by: architect, on behalf of economy, manufacturing, retail, finance, ui, content, qa.
Date: 2026-11-08. Type: **breaking** (`SCHEMA_VERSION` 1 -> 2: four new required slices; content
type revisions; `Scenario.content`). Everything below is to be transcribed by `schema` into
`packages/sim/src/schema`; names are final unless schema counter-proposes in `docs/schema-requests.md`.
Conventions: hand-written interfaces are the truth, each has a zod validator `satisfies z.ZodType<T>`,
`strictObject` everywhere, branded ids via the existing transform pattern, optional fields
`exactOptional`, every typed slice ships a deep-frozen `EMPTY_<SLICE>` constant.

## 1. `ids.ts` (additive)

```ts
export type BankId = Brand<string, 'BankId'>;            // authored slug
export const bankId = (s: string): BankId => s as BankId;
export const BankIdSchema = slugSchema<BankId>();
```

## 2. `inventory.ts` (new, shared by manufacturing and retail; ADR-012)

```ts
export interface InventoryLot { quantity: Quantity; value: Money; received: Quantity; issued: Quantity }
export const InventoryLotSchema: z.ZodType<InventoryLot>;   // value >= 0; refine received - issued === quantity
export const EMPTY_LOT: InventoryLot;                         // all zero, deep-frozen
```

## 3. `content.ts` (revised; replaces M0 `Facility`/`Store`/`MarketDemand`/`Market`)

```ts
export type ProductCategory = 'raw' | 'intermediate' | 'consumer';
export interface Product { id: ProductId; name: string; category: ProductCategory; unit: string; basePrice: Money /* >= 1 */; elasticity: number /* 0..5 */ }
export interface RecipeLine { product: ProductId; quantity: Quantity /* >= 1 */ }
export interface Recipe { id: RecipeId; name: string; facilityType: FacilityTypeId; inputs: RecipeLine[]; outputs: RecipeLine[] /* >= 1 */; durationTicks: number /* int >= 1 */; laborCostPerBatch: Money /* >= 0 */ }
export type FacilityKind = 'farm' | 'mine' | 'factory';
export interface FacilityType { id: FacilityTypeId; name: string; kind: FacilityKind; buildCost: Money /* >= 0 */; constructionTicks: number /* int >= 0 */; dailyOperatingCost: Money /* >= 0 */; capacity: Quantity /* >= 1 */; storageCapacity: Quantity /* >= 1 */; usefulLifeMonths: number /* int >= 1 */ }
export interface StoreFormat { id: StoreFormatId; name: string; buildCost: Money; constructionTicks: number; dailyOperatingCost: Money; shelfCapacity: Quantity /* >= 1 */; usefulLifeMonths: number /* int >= 1 */; categories: ProductCategory[] /* >= 1 */; shrinkagePerMille: number /* int 0..100 */ }
export interface Region { id: RegionId; name: string }
export interface City { id: CityId; name: string; region: RegionId; population: Quantity }
export interface MarketDemand { product: ProductId; baseDailyDemand: Quantity; priceFactor: number /* 0.1..10 */ }
export interface Market { id: MarketId; name: string; city: CityId; demand: MarketDemand[] }
export interface PricingTunables { alpha: number /* (0,1) */; beta: number /* (0,1) */; kappa: number /* (0,0.5] */; maxCapture: number /* [1,3] */ }
export interface MacroTunables { inflationAnnual: number /* [-0.5,1] */; policyRate: number /* [0,1] */; demandIndex: number /* (0,10] */ }
export interface CommoditySource { product: ProductId; referenceDailyVolume: Quantity /* >= 1 */; alpha: number /* (0,1) */; kappa: number /* (0,0.5] */ }
export interface SpreadTier { maxLeverage: number /* > 0 */; spread: number /* >= 0 */ }
export interface Bank { id: BankId; name: string; spreadTiers: SpreadTier[] /* >= 1, ascending maxLeverage */; minEquity: Money; minTermMonths: number; maxTermMonths: number /* 1..120, min <= max */; minPrincipal: Money /* >= 1 */; maxPrincipalToEquity: number /* > 0 */; latePenaltySpread: number /* >= 0 */; defaultAfterMissed: number /* int >= 1 */; overdraftLimit: Money /* >= 0 */; overdraftAnnualRate: number /* [0,1] */ }

export interface EconomyContent { pricing: PricingTunables; macro: MacroTunables; commodities: Record<ProductId, CommoditySource> }
export interface FinanceContent { banks: Record<BankId, Bank> }
export interface ContentPack {
  products: Record<ProductId, Product>; recipes: Record<RecipeId, Recipe>;
  facilityTypes: Record<FacilityTypeId, FacilityType>; storeFormats: Record<StoreFormatId, StoreFormat>;
  regions: Record<RegionId, Region>; cities: Record<CityId, City>; markets: Record<MarketId, Market>;
  economy: EconomyContent; finance: FinanceContent;
}
export const EMPTY_CONTENT_PACK: ContentPack;   // empty records; pricing {0.05,0.25,0.3,1.5}; macro {0,0.04,1}; deep-frozen
export const ContentPackSchema: z.ZodType<ContentPack>;   // key === id refinements + cross-references (below)

/** Raw parsed JSON of each data/ file (arrays / objects as authored). */
export interface ContentFiles { products: unknown; recipes: unknown; facilityTypes: unknown; storeFormats: unknown; regions: unknown; cities: unknown; markets: unknown; pricing: unknown; macro: unknown; commodities: unknown; banks: unknown }
export interface ContentValidationError { code: 'invalid_shape' | 'duplicate_id' | 'cross_reference'; issues: string[] }
export function assembleContentPack(files: ContentFiles): Result<ContentPack, ContentValidationError>;
```

Cross-reference rules in `ContentPackSchema` (and thus `assembleContentPack`): recipe
`facilityType` exists; every `RecipeLine.product` exists; `City.region` exists; `Market.city`
exists and **at most one market per city**; every `MarketDemand.product` exists and is not `raw`;
every `CommoditySource.product` exists and is `raw`; every `raw` product has exactly one source;
`Bank.spreadTiers` ascending; `minTermMonths <= maxTermMonths`. Duplicate ids within a file ->
`duplicate_id`.

## 4. `scenario.ts` (breaking in TS, compatible on the wire; ADR-010)

```ts
export interface ScenarioCompany { name: string; controller: ScenarioController; startingCash: Money; homeCity?: CityId }
export interface Scenario { id: string; name: string; epochYear: number; companies: ScenarioCompany[]; content: ContentPack }
// ScenarioSchema: `content` defaults to EMPTY_CONTENT_PACK when absent (so v1 envelopes, fixtures and
// data/scenarios/*.json parse); refine: every homeCity exists in content.cities.
```

Fixtures: `EMPTY_SCENARIO`/`SMOKE_SCENARIO` gain `content: EMPTY_CONTENT_PACK`. Add `M1_CONTENT_PACK`
and `VERTICAL_SLICE_SCENARIO` **test fixtures** in `fixtures.ts` mirroring `data/` (tiny: one of
each thing) so systems' unit tests need no file I/O; `data/` remains the authored source for the
game and sim-tests loads it.

## 5. Slice types (new files `economy.ts`, `manufacturing.ts`, `retail.ts`, `finance.ts`)

Exactly the interfaces in `docs/design/economy.md` section 3, `manufacturing.md` section 3,
`retail.md` section 3 and `finance.md` section 3, with these validators and empties:

```ts
export const EMPTY_ECONOMY_STATE: EconomyState = { macro: { priceIndex: 1, policyRate: 0, demandIndex: 1, lastMonthApplied: 0 }, markets: {}, commodities: {} };
export const EMPTY_MANUFACTURING_STATE: ManufacturingState = { facilities: {} };
export const EMPTY_RETAIL_STATE: RetailState = { stores: {} };
export const EMPTY_FINANCE_STATE: FinanceState = { loans: {}, credit: {} };
```

Refinements: record key === entity `id` (facilities, stores, loans, markets, credit by `companyId`);
`WipBatch[]` ascending `completesTick`; `demandRemaining <= demandToday`; `level` finite; lots via
`InventoryLotSchema`; `price` nullable `Money >= 1`; `FacilityStatus`/`StoreStatus`/`LoanStatus`/`StarvedReason` enums.

## 6. `world.ts`

```ts
export type TypedSliceSystemId = 'core' | 'accounting' | 'economy' | 'manufacturing' | 'retail' | 'finance';
export interface WorldState extends UntypedSlices {  /* ...core fields... */
  companies: Record<CompanyId, Company>; accounting: AccountingState;
  economy: EconomyState; manufacturing: ManufacturingState; retail: RetailState; finance: FinanceState;
}
/** For the engine: empty value per typed domain slice, so createWorld/migrations never hand-write shapes. */
export const EMPTY_TYPED_SLICES: Readonly<Record<Exclude<TypedSliceSystemId, 'core'>, unknown>>;
```

`untypedSliceShape` shrinks to `logistics`, `ai`, `hr`.

## 7. `commands.ts` (additive members; snake_case per ARCHITECTURE 7.1)

```ts
interface BuildFacilityCommand      extends CommandBase { type: 'facility.build';            payload: { companyId: CompanyId; facilityTypeId: FacilityTypeId; cityId: CityId } }
interface SetRecipeCommand          extends CommandBase { type: 'facility.set_recipe';       payload: { facilityId: FacilityId; recipeId: RecipeId | null } }
interface SetProductionCommand      extends CommandBase { type: 'facility.set_production';   payload: { facilityId: FacilityId; targetBatches: Quantity } }
interface BuildStoreCommand         extends CommandBase { type: 'store.build';               payload: { companyId: CompanyId; storeFormatId: StoreFormatId; cityId: CityId } }
interface SetPriceCommand           extends CommandBase { type: 'store.set_price';           payload: { storeId: StoreId; productId: ProductId; price: Money | null } }
interface SetRestockPolicyCommand   extends CommandBase { type: 'store.set_restock_policy';  payload: { storeId: StoreId; productId: ProductId; sourceFacilityId: FacilityId | null; targetStock: Quantity } }
interface RequestLoanCommand        extends CommandBase { type: 'loan.request';              payload: { companyId: CompanyId; principal: Money; termMonths: number } }
interface RepayLoanCommand          extends CommandBase { type: 'loan.repay';                payload: { loanId: LoanId; amount: Money } }
export type Command = RenameCompanyCommand | BuildFacilityCommand | SetRecipeCommand | SetProductionCommand | BuildStoreCommand | SetPriceCommand | SetRestockPolicyCommand | RequestLoanCommand | RepayLoanCommand;
```

Shape validation only (`principal` any `Money`; `termMonths` int >= 1; semantics belong to handlers).
Extend `COMMAND_TYPES`, `CommandTypeSchema`, `CommandSchema`, `CommandInputSchema`.

## 8. `events.ts` (additive members)

```ts
// economy
'market.opened'            { marketId: MarketId; cityId: CityId }
'macro.month_applied'      { tick: number; priceIndex: number }
'commodity.purchased'      { companyId: CompanyId; productId: ProductId; quantity: Quantity; unitPrice: Money; total: Money }
// manufacturing
'facility.ordered'         { facilityId: FacilityId; companyId: CompanyId; facilityTypeId: FacilityTypeId; cityId: CityId; completesTick: number }
'facility.completed'       { facilityId: FacilityId }
'facility.recipe_set'      { facilityId: FacilityId; recipeId: RecipeId | null }
'facility.production_set'  { facilityId: FacilityId; targetBatches: Quantity }
'production.completed'     { facilityId: FacilityId; recipeId: RecipeId; batches: Quantity; outputs: { productId: ProductId; quantity: Quantity; cost: Money }[] }
'production.starved'       { facilityId: FacilityId; reason: StarvedReason; wanted: Quantity; started: Quantity }
// retail
'store.ordered'            { storeId: StoreId; companyId: CompanyId; storeFormatId: StoreFormatId; cityId: CityId; completesTick: number }
'store.opened'             { storeId: StoreId }
'store.price_set'          { storeId: StoreId; productId: ProductId; price: Money | null }
'store.restock_policy_set' { storeId: StoreId; productId: ProductId; sourceFacilityId: FacilityId | null; targetStock: Quantity }
'store.restocked'          { storeId: StoreId; facilityId: FacilityId; productId: ProductId; quantity: Quantity; cost: Money }
'store.restock_failed'     { storeId: StoreId; productId: ProductId; code: string }
'store.sold'               { storeId: StoreId; productId: ProductId; quantity: Quantity; revenue: Money; cogs: Money; price: Money; referencePrice: Money; stockout: boolean }
// finance
'loan.issued'              { loanId: LoanId; companyId: CompanyId; principal: Money; termMonths: number; annualRate: number }
'loan.payment'             { loanId: LoanId; principal: Money; interest: Money; outstanding: Money }
'loan.payment_missed'      { loanId: LoanId; due: Money; cash: Money }
'loan.defaulted'           { loanId: LoanId }
'loan.repaid'              { loanId: LoanId; principal: Money; interest: Money }
'loan.closed'              { loanId: LoanId }
'credit.overdrawn'         { companyId: CompanyId; cash: Money }
'credit.insolvent'         { companyId: CompanyId; cash: Money; limit: Money }
'credit.restored'          { companyId: CompanyId }
```

Each is `interface XEvent extends EventBase { type; payload }`; extend `Event`, `EVENT_TYPES`,
`EventSchema`. `source` is stamped by the engine.

## 9. `snapshot.ts`: `SCHEMA_VERSION = 2` and migration notes (for the engine's `MIGRATIONS[1]`)

v1 -> v2 state migration: set `state.economy = EMPTY_ECONOMY_STATE`, `state.manufacturing =
EMPTY_MANUFACTURING_STATE`, `state.retail = EMPTY_RETAIL_STATE`, `state.finance = EMPTY_FINANCE_STATE`
(deep copies), **replacing** any pre-existing untyped value under those keys (section 11). Nothing
else in `state` changes. The envelope's `scenario` parses unchanged (`content` defaults). Engine
follow-ups: `createWorld` installs copies of `EMPTY_TYPED_SLICES[id]` for every typed domain slice
whose system is not registered (today it hand-writes `accounting` only); `restore` continues to
require a slice per registered system. qa follow-up: regression hashes change (new state keys) and
must be deliberately updated once, with this request cited.

## 10. Scenario content (for `content`/`game-design`, not schema)

`data/scenarios/vertical_slice.json`: `{ id: 'vertical_slice', name: 'Vertical slice', epochYear: 2000,
companies: [{ name: 'Player Co', controller: 'player', startingCash: 50_000_000, homeCity: '<city>' }] }`
(no starting facilities). The data set: one `raw` product with a commodity source, one `consumer`
product, one recipe (`durationTicks` 1..3), one factory type, one store format (`categories:
['consumer']`, `shrinkagePerMille: 0`), one region, one city, one market with demand for the consumer
product, one bank. Units chosen so every price is >= 1 minor unit (ARCHITECTURE 4).
