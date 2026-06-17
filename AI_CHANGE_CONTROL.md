# AI_CHANGE_CONTROL.md

## Purpose

Prevent AI agents from overwriting work outside their assigned responsibility.

Status: ACTIVE project governance for PODDROP, Canine Keepsakes, and PageReady — until replaced by a newer version.

---

## ROLE DEFINITIONS

### Claude

Owns:

- Architecture
- Code
- Components
- APIs
- Database
- Routing
- State Management
- Integrations
- Performance
- Reliability
- Testing
- Deployment

Claude may:

- Create files
- Move files
- Refactor code
- Improve performance
- Add features

Claude must NOT:

- Rewrite approved marketing copy
- Change pricing strategy
- Change sales messaging
- Change SEO copy
- Change landing page positioning
- Change approved CTA text

Unless explicitly instructed.

### ChatGPT

Owns:

- Sales copy
- Homepage messaging
- Landing page copy
- Product descriptions
- Email sequences
- SEO copy
- Meta titles
- Meta descriptions
- CTA text
- Offer positioning
- Conversion optimisation

ChatGPT may:

- Rewrite text
- Recommend page structure
- Recommend conversion changes

ChatGPT must NOT:

- Change architecture
- Change APIs
- Change routing
- Change integrations
- Change database models
- Change business logic

Unless explicitly instructed.

---

## FILE OWNERSHIP

Claude-Owned:

```
src/  components/  api/  lib/  services/  database/  integrations/
```

Shared:

```
app/  pages/
```

ChatGPT-Owned:

```
content/  marketing/  seo/  copy/  emails/
```

---

## CHANGE REQUEST FORMAT

Before any modification, Claude must provide:

1. File path
2. Section being changed
3. Reason
4. Expected impact

Example:

```
File:     src/app/home/page.tsx
Section:  Hero CTA
Reason:   Marketing update requested
Owner:    ChatGPT
Approval: Required
```

---

## PROTECTED SECTIONS

Any section marked Claude-owned may not be edited by ChatGPT.
Any section marked ChatGPT-owned may not be edited by Claude.

---

## REVIEW WORKFLOW

1. Claude builds feature.
2. Claude identifies reviewable copy.
3. ChatGPT reviews copy only.
4. ChatGPT returns approved replacement text.
5. Claude implements approved copy.
6. Claude tests implementation.

---

## GOLDEN RULE

Neither AI may modify another AI's owned section without explicit approval.
