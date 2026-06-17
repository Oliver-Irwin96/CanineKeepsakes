# PROJECT_OWNERSHIP_MATRIX.md

Quick-reference ownership lookup. Governs PODDROP, Canine Keepsakes, and PageReady.
Companion to AI_CHANGE_CONTROL.md — that document is the full policy; this is the fast lookup.
If the two ever conflict, AI_CHANGE_CONTROL.md wins.

Status: ACTIVE — until replaced by a newer version.

---

## THE CHECK (run before touching any file)

```
1. Who owns this file/section?   → Claude | ChatGPT | Shared
2. Is it approved copy?          → if yes, do NOT change without explicit instruction
3. Does it need review?          → Shared or ChatGPT-owned copy = flag "ChatGPT Review Recommended"
4. Proceed only if owned by Claude, OR explicitly instructed.
```

---

## OWNERSHIP TABLE

### ChatGPT-Owned (Claude must NOT edit without explicit instruction)

```
HOMEPAGE COPY              → ChatGPT
LANDING PAGE COPY          → ChatGPT
PRODUCT DESCRIPTIONS       → ChatGPT
COLLECTION COPY            → ChatGPT
PRICING COPY / POSITIONING → ChatGPT
EMAIL SEQUENCES            → ChatGPT
ONBOARDING COPY            → ChatGPT
CTA TEXT                   → ChatGPT
OFFER POSITIONING          → ChatGPT
SEO COPY                   → ChatGPT
META TITLES                → ChatGPT
META DESCRIPTIONS          → ChatGPT
CONVERSION OPTIMISATION    → ChatGPT
```

### Claude-Owned (Claude retains ownership)

```
ARCHITECTURE               → Claude
CODE                       → Claude
COMPONENTS                 → Claude
API                        → Claude
DATABASE / MODELS          → Claude
QUEUE SYSTEM               → Claude
WORKERS                    → Claude
ROUTING                    → Claude
STATE MANAGEMENT           → Claude
INTEGRATIONS               → Claude
SHOPIFY (integration)      → Claude
PRINTFUL (integration)     → Claude
DEPLOYMENT / INFRA         → Claude
PERFORMANCE                → Claude
RELIABILITY                → Claude
TESTING                    → Claude
```

### Shared (review required before changing copy-bearing sections)

```
LANDING PAGES (page files) → Shared   — Claude: structure/logic | ChatGPT: copy
PRICING PAGE (page file)   → Shared   — Claude: structure/logic | ChatGPT: copy
ONBOARDING FLOW            → Shared   — Claude: flow/logic      | ChatGPT: copy
HOMEPAGE (page file)       → Shared   — Claude: structure/logic | ChatGPT: copy
```

---

## DIRECTORY MAP

```
Claude-Owned:   src/  components/  api/  lib/  services/  database/  integrations/
Shared:         app/  pages/
ChatGPT-Owned:  content/  marketing/  seo/  copy/  emails/
```

---

## CLASSIFICATION RULE OF THUMB

- Touches words a customer reads (homepage, landing, pricing, email, onboarding,
  product/collection copy, CTA, SEO/meta) → **ChatGPT Review Recommended**.
- Touches how the system runs (architecture, API, DB, queue, worker, deployment,
  integration, infrastructure) → **Claude owns it**.
- File contains both (a `page` file with copy + logic) → **Shared**: Claude edits
  structure/logic, copy stays ChatGPT's and is flagged for review.

---

## COMPLETION REPORT FORMAT (Claude provides on every change)

```
Files changed:           <paths>
Ownership category:      Claude | ChatGPT | Shared
ChatGPT review points:   <copy/sections needing review, or "none">
Risks:                   <impact / regressions / things to watch>
```

---

## PER-PROJECT NOTES

- **PODDROP** — SaaS platform. Printful OAuth, Setup Wizard, AI workstation are
  Claude-owned (integration/architecture). Wizard *copy* is ChatGPT-owned.
- **Canine Keepsakes** — Shopify store. Printful bot, store integration, design
  pipeline are Claude-owned. Product/collection descriptions and store copy are
  ChatGPT-owned.
- **PageReady** — Claude owns code/architecture; ChatGPT owns marketing/SEO/landing copy.

---

GOLDEN RULE: Neither AI modifies another AI's owned section without explicit approval.
