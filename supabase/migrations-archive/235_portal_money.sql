-- ============================================================
-- 235_portal_money — CF-3 money & approvals (docs/CRM_Design.md §8,
-- absorbing portal roadmap B4 e-sign + C1 payments).
--
--   portal_jobs.approvals — jsonb array of published change orders:
--     [{id, title, description, amountDelta, status: pending|approved|
--       declined, publishedAt, respondedAt, signedName, signature, note}]
--     Published by the office (a direct authenticated PATCH, NOT via
--     publishPortal — a republish must never reset a customer's answer);
--     answered by the customer through the gateway's respondApproval.
--
--   portal_jobs.billing — office-shared money roll-up:
--     {invoiced, paid, balance, payUrl, asOf}
--     Computed by fincalc.billingSummary (QBO balance = ground truth on
--     tracked invoices), optionally carrying the QBO online-payment link.
--
-- Both columns are deliberately OUTSIDE publishPortal's upsert payload,
-- the same omit-the-key discipline that protects contact_id: absent
-- keys are untouched by merge-duplicates, so a publish can never
-- clobber an approval response or un-share the balance.
--
-- SAFE & additive. Rollback: drop the two columns.
-- ============================================================

alter table public.portal_jobs add column if not exists approvals jsonb not null default '[]'::jsonb;
alter table public.portal_jobs add column if not exists billing jsonb;

comment on column public.portal_jobs.approvals is
  'CF-3 change-order approvals: office-published, customer-answered (e-sign via the gateway). Never written by publishPortal.';
comment on column public.portal_jobs.billing is
  'CF-3 shared balance: {invoiced, paid, balance, payUrl, asOf} from fincalc.billingSummary. Null = not shared.';
