# Quido Interactive Prototype — Logic Architecture Framework

## What is broken now

The prototype already has the right intention, but the logic is split across too many competing sources of truth.

### Current state in the uploaded files

1. `quido_ops.html` and `quido_loans.html` both define their own `CUSTOMER_REGISTRY` with five customers.
2. Both apps seed `localStorage` per customer and use `BroadcastChannel('proto_sync')` plus polling for sync.
3. The ops app writes account changes into `localStorage` and stores loan changes under `loanOverrides` before broadcasting updates to the customer UI.
4. The customer UI partially reads from `localStorage`, but several sections still render hardcoded Sarah Mitchell / Loan #28796 content, especially payment details and generated documents.
5. The loan engine exists as a separate backend-style module (`quido_loan_engine.js`), but the HTML apps also reimplement loan logic inline.

This creates four competing truth sources:

- demo registry seed data
- localStorage account object
- inline app runtime state (`LOAN`, `OPS`)
- hardcoded DOM content / hardcoded document templates

That is why the prototype becomes unstable and difficult to reason about.

## Architecture decision

Do **not** keep patching individual screens.

Use a **single canonical account aggregate** for each customer, and make both apps read/write through the same shared logic layer.

For this prototype, the most practical pattern is:

**Aggregate snapshot + audit log**, not full event sourcing.

That means:
- one persisted account object per customer
- one append-only event log inside that account
- one shared domain engine that recalculates the loan snapshot after each command
- both UIs become view shells that render from the same state

## Target architecture

```text
Customer UI ─┐
             ├── App Controller ─── Shared Account Store ─── Repository Adapter ─── localStorage (prototype)
Ops UI ──────┘               │                    │
                             │                    └── later: REST / DB API
                             │
                             ├── Loan Domain Service (wraps LoanEngine)
                             ├── Document Service
                             ├── Selectors / View Models
                             └── Sync Bus (BroadcastChannel + storage fallback)
```

## Core rule

### Only one thing is canonical:

`CustomerAccount`

Everything else is either:
- seed data used only on first creation
- derived state
- UI rendering
- transport / sync mechanism

## Canonical account schema

Use this as the shared shape for both apps.

```js
{
  schemaVersion: 1,
  accountId: "customer_28796",
  storageKey: "np_customer_28796",

  identity: {
    customerId: "customer_28796",
    loanId: "28796",
    firstName: "Sarah",
    lastName: "Mitchell",
    title: "Ms",
    initials: "SM",
    memberSince: "2025-01-01"
  },

  contact: {
    email: "sarah.mitchell@email.co.uk",
    phone: "+44 7700 900 7821",
    address: "42 Elm Grove, Brighton, BN2 3FA",
    residentSince: "2020-01-01"
  },

  personal: {
    dob: "1989-03-14"
  },

  employment: {
    status: "Full-time employed",
    employer: "Mitchell & Co Ltd",
    jobTitle: "Senior Analyst",
    employmentStart: "2019-03-01",
    annualIncome: 42000,
    payFrequency: "Monthly",
    nextPayDate: "2026-03-28"
  },

  affordability: {
    monthlyIncome: 2800,
    housingCosts: 850,
    transportCosts: 120,
    livingCosts: 450,
    otherDebts: 150,
    disposableIncome: 1230
  },

  paymentMethods: {
    card: {
      type: "Visa Debit",
      last4: "4821",
      expiry: "09/27",
      collectionDayOfMonth: 22,
      active: true
    },
    bank: {
      accountHolder: "Sarah Mitchell",
      bankName: "Barclays Bank",
      sortCodeMasked: "20 ·· ·· ··",
      accountNumberMasked: "•••• 3847",
      fundedToDate: "2026-01-24"
    }
  },

  loan: {
    contract: {
      principal: 1000,
      apr: 29.9,
      termMonths: 12,
      startDate: "2026-01-24"
    },

    servicing: {
      accountStatus: "active",
      paidCount: 2,
      paymentHolidayCount: 0,
      arrangementActive: false,
      arrangementAmount: null,
      arrangementMonths: null,
      termExtensions: 0
    },

    snapshot: {
      emi: 97.44,
      totalRepayable: 1169.28,
      totalInterest: 169.28,
      outstandingBalance: 0,
      totalRepaid: 0,
      principalPaid: 0,
      interestPaid: 0,
      instalmentsRemaining: 0,
      nextInstalment: null,
      schedule: []
    }
  },

  documents: {
    secci: { issuedAt: "2026-01-24T14:32:00Z" },
    adequateExplanation: { issuedAt: "2026-01-24T14:32:00Z" },
    cancellationNotice: { issuedAt: "2026-01-24T14:32:00Z" },
    agreement: { signedAt: "2026-01-24T14:32:00Z" }
  },

  ops: {
    notes: [],
    contactLog: [],
    collectionsFlagged: false
  },

  audit: {
    createdAt: "2026-03-25T12:00:00Z",
    updatedAt: "2026-03-25T12:00:00Z",
    lastTouchedBy: "customer_ui"
  },

  events: []
}
```

## Why this schema fixes the inconsistency

Because each screen gets a defined owner for its data:

- profile screen → `identity`, `contact`, `personal`, `employment`
- income & expenditure → `affordability`
- payment details → `paymentMethods`
- loan dashboard, statement, options → `loan.snapshot`
- ops actions → `loan.servicing` + `events`
- documents → `documents` + `identity/contact/loan.snapshot`

No screen should ever read directly from static HTML defaults after boot.

## Repository pattern

Create a single repository interface.

```js
class AccountRepository {
  getByStorageKey(storageKey) {}
  save(account) {}
  listSeedCustomers() {}
  createFromSeed(seedCustomer) {}
}
```

### Prototype adapter now
- `LocalStorageAccountRepository`

### Real backend later
- `HttpAccountRepository`
- backing database table / document store

Because both adapters implement the same interface, the apps do not care whether persistence is localStorage or an API.

## Shared store

Create one shared store module used by both apps.

### Responsibilities
- load account
- normalize / migrate account shape
- dispatch commands
- recompute loan snapshot
- persist account
- publish sync event
- notify subscribers

### Interface

```js
const store = createAccountStore({ repository, syncBus, loanService, documentService });

store.load(storageKey);
store.getState();
store.subscribe(listener);
store.dispatch({ type, payload, actor });
```

## Command model

Stop letting random UI code mutate DOM and storage directly.

All writes go through commands.

### Required commands

```js
LOGIN_CUSTOMER
SELECT_CUSTOMER
UPDATE_PROFILE
UPDATE_CONTACT
UPDATE_EMPLOYMENT
UPDATE_AFFORDABILITY
UPDATE_PAYMENT_METHODS
RECALCULATE_LOAN
RECORD_PAYMENT
APPLY_PAYMENT_HOLIDAY
APPLY_PAYMENT_ARRANGEMENT
CHANGE_ACCOUNT_STATUS
CHANGE_PAY_DATE
EXTEND_TERM
WAIVE_INTEREST
ADD_OPS_NOTE
ADD_CONTACT_ATTEMPT
FLAG_COLLECTIONS
CLOSE_ACCOUNT
```

### Command flow

```text
UI action
→ dispatch(command)
→ reducer / handler validates input
→ mutate canonical account object
→ run LoanService.rebuildSnapshot(account)
→ run DocumentService.refreshMetadata(account)
→ append audit event
→ repository.save(account)
→ syncBus.publish(event)
→ subscribed views rerender
```

## Loan architecture

## Current issue

You have:
- `quido_loan_engine.js` as backend reference
- duplicated inline schedule logic inside both HTML apps

That duplication must stop.

## Target rule

There should be **one loan service** that wraps the engine.

```js
class LoanService {
  buildSnapshot(account) {}
  recordPayment(account, payload) {}
  applyPaymentHoliday(account, payload) {}
  applyPaymentArrangement(account, payload) {}
  extendTerm(account, payload) {}
  changeStatus(account, payload) {}
}
```

### Important implementation choice

For the prototype, persist the **loan snapshot** after every command.

That gives you:
- deterministic UI on reload
- no hidden recalculation drift
- easier debugging
- simpler cross-app sync

So `loan.contract` and `loan.servicing` are inputs, and `loan.snapshot` is the persisted output.

## View selectors

Each screen should render from selectors only.

```js
selectDashboard(state)
selectProfile(state)
selectPaymentDetails(state)
selectStatement(state)
selectDocuments(state)
selectOpsOverview(state)
selectCollections(state)
```

This is where you solve the Sarah-clone problem.

For example:

### `selectDocuments(state)`
Should return a fully dynamic document model using:
- `state.identity.firstName`
- `state.identity.lastName`
- `state.contact.address`
- `state.identity.loanId`
- `state.loan.snapshot`
- `state.documents.*`

This removes the hardcoded `#28796`, `Sarah Mitchell`, and Brighton address currently embedded in the document builder.

### `selectPaymentDetails(state)`
Should return:
- active card
- bank account
- collection schedule
- any fallback display values

This removes the hardcoded Visa/4821/Barclays assumptions from the customer UI.

## Sync bus

Keep the current prototype sync concept, but narrow its responsibility.

### Current problem
Both apps are treating BroadcastChannel as part transport, part business logic.

### Target
The sync layer should only notify that state changed.

```js
class SyncBus {
  publish({ accountId, type, timestamp }) {}
  subscribe(handler) {}
}
```

### Prototype implementation
- BroadcastChannel
- `storage` event fallback
- optional polling fallback if a tab misses the event

### Critical rule
The payload should not try to carry full business state.
Only send:
- accountId
- event type
- timestamp
- optional actor

Receiving app then reloads the canonical account from repository.

That removes dual-write drift.

## Seed registry rule

Keep `CUSTOMER_REGISTRY`, but only as **seed input**.

After account creation, the registry should no longer be used for rendering.

### Rule
- registry seeds first account creation
- repository stores canonical account
- all future reads come from repository only

## File/module plan

Create a shared logic folder and move all business logic there.

```text
/shared
  account-schema.js
  seed-customers.js
  account-repository.js
  localstorage-repository.js
  account-store.js
  sync-bus.js
  loan-service.js
  document-service.js
  selectors.js
  commands.js
  normalizers.js
  formatters.js

/apps
  customer-controller.js
  ops-controller.js
```

## Responsibility split

### `seed-customers.js`
Exports the 5 canonical seed accounts.

### `account-schema.js`
Contains default builders and migration helpers.

### `normalizers.js`
Ensures old accounts gain any missing fields.

### `loan-service.js`
Wraps `LoanEngine` and outputs a full loan snapshot.

### `document-service.js`
Builds document metadata and full document content from account state.

### `selectors.js`
Maps canonical state to screen-specific view models.

### `customer-controller.js`
Reads selectors and patches DOM.
No business rules.

### `ops-controller.js`
Reads selectors and dispatches commands.
No direct storage writes.

## Minimal migration sequence

Do this in order.

### Phase 1 — make data shape canonical
1. Extract one shared `CUSTOMER_REGISTRY`.
2. Create `normalizeAccount(seedOrStoredAccount)`.
3. Seed all 5 customers into canonical shape.
4. Stop storing loose `profile` keys for payment data; move them to `paymentMethods`.

### Phase 2 — centralize the loan engine
1. Remove inline schedule calculators from both HTML apps.
2. Use a single `LoanService` that calls `quido_loan_engine.js`.
3. Persist `loan.snapshot` after every command.

### Phase 3 — centralize writes
1. Replace direct `localStorage.setItem` calls with repository save.
2. Replace direct DOM writes for edits with `dispatch()` + rerender.
3. Replace `loanOverrides` with canonical `loan.contract` + `loan.servicing` + `loan.snapshot`.

### Phase 4 — centralize reads
1. Customer profile screen reads from selectors.
2. Payment details screen reads from selectors.
3. Statement screen reads from selectors.
4. Document builder reads from selectors.

### Phase 5 — simplify sync
1. Publish only account-changed events.
2. On receipt, reload state from repository.
3. Rerender active screen.

## What to remove from the current structure

### Remove as architecture concepts
- `loanOverrides` as a separate pseudo-source of truth
- duplicated inline loan calculators
- document templates with fixed customer values
- payment method fields hidden inside profile keys
- DOM-first editing followed by partial persistence

## What to keep
- BroadcastChannel idea
- per-customer storage keys
- five-account demo registry
- `LoanEngine` business calculations
- ops/customer split in UI

## Non-negotiable rules for Claude Code

1. No screen may own canonical data.
2. No screen may hardcode customer identity.
3. No direct storage writes from UI handlers.
4. No duplicated loan formulas outside `LoanService`.
5. No document content may be generated from constants like `#28796` or `Sarah Mitchell`.
6. No section should render from registry after account load.
7. Every write must append an event to `events`.

## Practical implementation note

Because you asked not to touch HTML/CSS, the safe refactor is:

- keep existing DOM IDs and structure
- replace inline business logic with shared controllers/selectors
- rerender the existing IDs from canonical state
- only rewrite JavaScript logic

That keeps the UI intact while replacing the broken architecture underneath.

## Immediate priority fixes

In this order:

1. Shared canonical schema
2. Shared repository/store
3. Shared loan service
4. Dynamic documents
5. Dynamic payment details
6. Remove `loanOverrides`
7. Replace polling-driven patching with repository reload + rerender

## Bottom line

You do not have a “bug problem”.
You have a **state architecture problem**.

The right fix is to make both apps thin clients over one shared account model, one shared loan service, one shared repository, and one shared sync bus.
