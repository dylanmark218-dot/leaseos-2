# P6.6 and P6.7 — decision brief

These two are your policy rather than a regulator's, so unlike the other nine they need no outside
answer. This is what is currently seeded and what is actually ambiguous, so the decision is a review
rather than a blank page.

Measured at `f76b08c`.

---

## P6.7 — which limit governs a purchase order

**There are two limit sources and only one of them is consulted.** That is the finding, and it
matters more than the choice between them.

| | Read from | Used by | Status today |
|---|---|---|---|
| **Spending limits** | `spendingLimits`, per financial entity, with effective dates | `purchasingRouter` via `limitsFor()` — at request and at approval | **Governs purchase orders** |
| **Approval ladder** | `commercialApprovalPolicies`, category `purchase_order` | `commercialApprovalService`, `commercialOfficeRouter` | **Never read on the purchase-order path** |

So the four `purchase_order` tiers seeded in `0133` — including a real one somebody configured,
`≤ $1,000 → office` — have no effect on a purchase order today. Someone editing that tier would see
the change save successfully and change nothing, which is the failure mode worth fixing whichever
way you decide.

### What each is good at

**Spending limits** are per financial entity with effective dates. They answer "this entity may
commit up to X", they expire, and they already work on the path that matters.

**The approval ladder** is per category across six categories (`purchase_order`, `vendor_bill`,
`payment`, `credit`, `write_off`, `rate_override`) with an approver role and a second-person flag.
It answers "who signs for an amount of this size", consistently across all six.

### The three options

1. **Spending limits govern; remove the `purchase_order` tiers.** Simplest, and honest about what is
   already true. Cost: purchase orders are then the one category with no ladder, and the
   second-person rule above $25,000 does not apply to them.
2. **The ladder governs; `limitsFor` becomes an entity cap checked alongside it.** Consistent across
   all six categories and brings POs under the second-person rule. Cost: a real code change on a
   path that currently works, and two rules to satisfy instead of one.
3. **Both, with a stated precedence — the more restrictive wins.** Defensible and the most work; it
   needs a rule for what happens when the entity limit is silent, which must be "no opinion", not
   "unlimited".

**My read:** option 2, because the thing purchase orders currently lack is the second-person rule at
the top tier, and that is the rule most worth having. But option 1 is not wrong, and it is the only
one that requires no code.

Whichever you choose, the other source should stop being editable on that path, or the next person
to adjust it will believe they changed something.

---

## P6.6 — the approval-ladder role mapping

Seeded in `0133`, and every row carries its own provenance in its `source` column, including the
words **"confirm mapping"**. Nothing here is asserting your approval.

The mapping applied to all six categories:

| Your words (2026-09-17) | Seeded as | Second person |
|---|---|---|
| supervisor, up to $5,000 | `controller` | no |
| manager, up to $25,000 | `management` | no |
| administrator / owner, above $25,000 | `management` | **yes** |

Plus one row that is not from that decision: `purchase_order ≤ $1,000 → office`, marked
`business_defined by user 240017191`. That is the per-business override working as intended, and it
is the only row a person configured rather than a migration seeded.

### The two things actually worth your attention

**"Supervisor" became `controller`.** That is the substantive guess. LeaseOS has no `supervisor`
role, and the decision described that person as the one "who decides credits and write-offs" —
which is a controller's job. If your supervisors are field supervisors rather than finance staff,
this is the wrong mapping and it currently gives them credit and write-off authority up to $5,000.

**Manager and owner both map to `management`.** The tiers are distinguished only by the
second-person flag, not by role. So a manager cannot approve above $25,000 alone, but the person who
does so with a second signature holds the same role. If you want owner-level approval to be its own
role, that is a role LeaseOS does not have yet.

### To confirm

If the mapping is right, the confirmation to record is: *supervisor→controller, manager→management,
owner→management-with-second-person, for all six categories, with the $5,000 / $25,000 boundaries as
seeded.* Recording it replaces "confirm mapping" in every `source` field with your approval.

If any part is wrong, the tiers are editable per business through the commercial office without a
migration — that is what the `business_defined` row demonstrates.

---

## What neither of these needs

No regulator, no external answer, no verification of a published figure. Both are decisions about
how your own company approves money, and both are currently running on a documented guess that says
so in its own data.
