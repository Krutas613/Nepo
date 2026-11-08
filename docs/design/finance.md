# Finance design (Milestone 1)

Owner of the code: `finance` (`packages/sim/src/finance`). Companion to ARCHITECTURE.md sections
5, 6, 8 and ADR-009/014. Types live in `schema/` (`docs/design/schema-m1.md`). M1 scope: one NPC
bank, one loan product (fixed-rate amortising term loan), an overdraft backstop, no equity.

## 1. Purpose and boundaries

Finance owns loans and each company's credit status, underwrites from accounting's statements,
accrues and collects interest, and flags overdrafts and defaults. It reads the policy rate from
`EconomyApi`, every balance and statement from `AccountingApi` (never a private copy), and posts
every cash flow through accounting builders. It exposes `FinanceApi` for the UI and AI.

Phases: **`apply`** (commands) and **`finance`** (daily overdraft check; month-end accrual, payments).

## 2. Content (`data/finance/banks.json`, type `Bank`, keyed by `BankId`; M1 has exactly one)

```ts
interface SpreadTier { maxLeverage: number; spread: number }        // ascending maxLeverage
interface Bank {
  id: BankId; name: string;
  spreadTiers: SpreadTier[];      // leverage after the loan -> annual spread over policy rate; beyond the last tier: rejected
  minEquity: Money;               // equity must be >= this after the draw (M1: > 0 in data)
  minTermMonths: number; maxTermMonths: number;   // 1..120
  minPrincipal: Money; maxPrincipalToEquity: number;   // principal <= equity × this
  latePenaltySpread: number;      // added to annualRate while a loan has missed payments
  defaultAfterMissed: number;     // consecutive missed payments -> defaulted
  overdraftLimit: Money; overdraftAnnualRate: number;  // ADR-014
}
```

Suggested M1: tiers `[{0.5, 0.02}, {1.0, 0.035}, {2.0, 0.05}]`, `minEquity 1`, terms 6..60,
`latePenaltySpread 0.05`, `defaultAfterMissed 3`, `overdraftLimit 5_000_000`, `overdraftAnnualRate 0.18`.

## 3. State (`FinanceState`, schema)

```ts
type LoanStatus = 'active' | 'defaulted' | 'closed';
interface Loan {
  id: LoanId; borrowerId: CompanyId; bankId: BankId;
  principal: Money; outstanding: Money;        // outstanding reconciles to 2500
  accruedInterest: Money;                      // unpaid accrued interest, reconciles (with overdraft) to 2100
  annualRate: number;                          // fixed at issue: policyRate + spread
  termMonths: number; monthsRemaining: number;
  drawnTick: number; lastAccrualTick: number;
  missedPayments: number; consecutiveMissed: number;
  status: LoanStatus;
}
interface CreditState {
  companyId: CompanyId;
  overdrawnSince: number | null; insolventSince: number | null;
  overdraftAccrued: Money;                     // unpaid overdraft interest (part of 2100)
}
interface FinanceState { loans: Record<LoanId, Loan>; credit: Record<CompanyId, CreditState> }
```

`init`: one `CreditState` per company in `sortedKeys(state.companies)`; `loans = {}`. A company that
appears later (M2 subsidiaries) gets its record on first use via `creditOf(companyId)`.

## 4. Underwriting (pure function `assessLoan`, used by `apply` and `FinanceApi.quoteLoan`)

Inputs: `bs = accounting.balanceSheet(companyId)` (live, computed from balances), `principal`,
`termMonths`, `bank`, `policyRate = economy.policyRate()`.

```
equity      = bs.equity;  debt = bs.liabilities
reject 'invalid_term'        unless minTermMonths <= termMonths <= maxTermMonths
reject 'below_minimum'       if principal < minPrincipal
reject 'insufficient_equity' if equity < bank.minEquity
reject 'principal_too_large' if principal > scaleMoney(equity, maxPrincipalToEquity)
leverage = (debt + principal) / equity          // float; equity > 0 here
tier     = first tier with leverage <= maxLeverage; reject 'leverage_exceeded' if none
rate     = policyRate + tier.spread            // float, fixed for the life of the loan
```

Statements are read live from the ledger (M1); M3 ratings will read `accounting.latestReport(c,
'quarter')` for trend. Finance keeps **no** copy of balances: every figure is fetched when needed.

## 5. Commands (phase `apply`)

| Type           | Payload                                 | Rejections (in order)                                                                           | Effect / event                                                                                                                                                                             |
| -------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loan.request` | `{ companyId, principal: Money, termMonths: number }` | `not_owner`, `no_bank` (content has no bank), then the `assessLoan` codes above                   | issue `LoanId`; post `loanDrawdown(principal)` Dr 1000 / Cr 2500 (`ref: { kind: 'loan', id }`); `Loan { outstanding = principal, accruedInterest 0, monthsRemaining = termMonths, drawnTick = lastAccrualTick = tick, status 'active' }`; emit `loan.issued` |
| `loan.repay`   | `{ loanId, amount: Money }`             | `unknown_loan`, `not_owner`, `loan_not_active`, `invalid_amount` (amount < 1), `insufficient_cash` (cash < amount; discretionary, ADR-014) | `interestPart = min(amount, accruedInterest)`, `principalPart = min(amount − interestPart, outstanding)`; post `loanRepayment(principalPart, interestPart)`; update; if `outstanding === 0 && accruedInterest === 0`: `status = 'closed'`, emit `loan.closed`; emit `loan.repaid { loanId, principal, interest }` |

Both are applied fully or rejected. A single company may hold several loans.

## 6. Finance phase (companies in `sortedKeys(credit)`, then loans in `sortedKeys(loans)`)

1. **Overdraft (daily, ADR-014).** `cash = accounting.cash(c)`. If `cash < 0`: if
   `overdrawnSince === null` set it and emit `credit.overdrawn { companyId, cash }`; accrue
   `i = scaleMoney(negMoney(cash), bank.overdraftAnnualRate / 360)`; if `i > 0` post
   `interestAccrual(i)` and `overdraftAccrued += i`. If `cash < −overdraftLimit` and
   `insolventSince === null`: set it, emit `credit.insolvent { companyId, cash, limit }`. If `cash >= 0`
   and `overdrawnSince !== null`: clear both `since` fields, emit `credit.restored`. On `isMonthEnd`,
   if `overdraftAccrued > 0`: post `loanRepayment(ZERO_MONEY, overdraftAccrued)` (Dr 2100 / Cr 1000),
   zero it (non-discretionary).
2. **Loan accrual (month end, loans `active` or `defaulted` with `outstanding > 0`).** On `isMonthEnd`
   and `tick > drawnTick`: `days = tick − lastAccrualTick` (1..30, prorates the first period);
   `rate = annualRate + (consecutiveMissed > 0 ? latePenaltySpread : 0)`;
   `interest = scaleMoney(outstanding, rate × days / 360)`; if `> 0` post `interestAccrual(interest)`;
   `accruedInterest += interest`; `lastAccrualTick = tick`. Interest does not compound (accrues on
   principal only).
3. **Scheduled payment (month end, `active` loans, same tick, after 2).**
   `principalDue = monthsRemaining <= 1 ? outstanding : allocateMoney(outstanding, [1, monthsRemaining − 1])[0]`
   (straight-line amortisation; annuity would need `pow`); `due = principalDue + accruedInterest`.
   If `cash − due >= −bank.overdraftLimit`: post `loanRepayment(principalDue, accruedInterest)`;
   `outstanding −= principalDue; accruedInterest = 0; monthsRemaining −= 1; consecutiveMissed = 0`;
   emit `loan.payment { loanId, principal, interest, outstanding }`; if `outstanding === 0`:
   `status = 'closed'`, emit `loan.closed`. Else: `missedPayments += 1; consecutiveMissed += 1`;
   `monthsRemaining` unchanged; emit `loan.payment_missed { loanId, due, cash }`; if
   `consecutiveMissed >= defaultAfterMissed` and `status === 'active'`: `status = 'defaulted'`, emit
   `loan.defaulted`. A `defaulted` loan keeps accruing at the penalty rate and accepts `loan.repay`
   (`loan_not_active` applies only to `closed`); M3 adds restructuring and seizure.

Within a month-end tick the order is: overdraft accrual/settlement, then per loan accrual then
payment, so the payment includes the month's interest and the ledger shows one accrual and one
payment per loan per month.

## 7. Service (`FINANCE_SERVICE: ServiceKey<FinanceApi>`; all reads via `handle.state()`)

```ts
type UnderwritingCode = 'no_bank' | 'invalid_term' | 'below_minimum' | 'insufficient_equity' | 'principal_too_large' | 'leverage_exceeded';
interface LoanQuote { principal: Money; termMonths: number; annualRate: number; firstPrincipalDue: Money; leverageAfter: number }
interface FinanceApi {
  loansOf(companyId: CompanyId): readonly DeepReadonly<Loan>[];                         // sorted by id
  credit(companyId: CompanyId): DeepReadonly<CreditState> | null;
  availableCredit(companyId: CompanyId): Money;        // largest principal accepted by assessLoan at maxTermMonths (binary search on integers, <= 60 steps)
  quoteLoan(companyId: CompanyId, principal: Money, termMonths: number): Result<LoanQuote, { code: UnderwritingCode; message: string }>;
  totalDebt(companyId: CompanyId): Money;             // Σ outstanding + Σ accrued (active/defaulted)
}
```

No write methods: loans change only through commands and the finance phase.

## 8. Accounting dependencies (requests to `accounting`, see docs/design/accounting.md section 2)

`AccountingApi.balanceSheet(entityId): BalanceSheet` and `latestReport(entityId, kind): PeriodReport | null`
(read-only). Builders used: `loanDrawdown`, `loanRepayment`, `interestAccrual` (all exist).

## 9. Events

`loan.issued { loanId, companyId, principal, termMonths, annualRate }`, `loan.payment { loanId, principal, interest, outstanding }`,
`loan.payment_missed { loanId, due, cash }`, `loan.defaulted { loanId }`, `loan.repaid { loanId, principal, interest }`,
`loan.closed { loanId }`, `credit.overdrawn { companyId, cash }`, `credit.insolvent { companyId, cash, limit }`,
`credit.restored { companyId }`.

## 10. Determinism notes

No RNG. Iteration via `sortedKeys`. Floats only in rates and leverage; every money figure goes
through `scaleMoney`/`allocateMoney`. `cash` and the balance sheet are read from accounting at the
moment of use.

## 11. Invariants qa will check (`checkFinanceInvariants(state: WorldState)`)

1. Per entity: `Σ outstanding over loans with status !== 'closed' === −balance(2500)` (exact).
2. Per entity: `Σ accruedInterest + credit.overdraftAccrued === −balance(2100)` (exact).
3. Per loan: `0 <= outstanding <= principal`; `status === 'closed' ⇒ outstanding === 0 && accruedInterest === 0`;
   `monthsRemaining <= termMonths`; `annualRate >= 0`.
4. Credit (invariant 3, ADR-014): `cash < 0 ⇒ overdrawnSince !== null`; `cash >= 0 ⇒ overdrawnSince === null`;
   `cash < −overdraftLimit ⇒ insolventSince !== null`.
5. Sweep metrics: count of `loan.payment_missed`, `loan.defaulted`, `credit.insolvent` events;
   total debt per company at the end.

## 12. Tests the owner must ship

- Underwriting table: each rejection code; tier selection at the boundaries; `availableCredit` equals
  the largest principal `quoteLoan` accepts (property over random balance sheets built with real postings).
- Loan life: draw on day 10, 6-month term → 6 payments, `Σ principal paid === principal`, first
  interest prorated for 20 days, `2500` and `2100` reconcile every tick, `loan.closed` on the last.
- Early repayment: partial (interest first), full (closes), rejected when `cash < amount`.
- Missed payment: scripted cash drain → `payment_missed`, penalty rate applied next month,
  `defaulted` after `defaultAfterMissed`; ledger invariants still hold; later repayment clears it.
- Overdraft: a daily opex fixture drives cash negative → `credit.overdrawn`, daily accrual, month-end
  settlement, `credit.restored` after a drawdown; `credit.insolvent` beyond the limit.
- fast-check property: random valid `loan.request`/`loan.repay` sequences over 720 ticks keep
  invariants 1-4 every tick.
- Determinism and snapshot/restore mid-run.
