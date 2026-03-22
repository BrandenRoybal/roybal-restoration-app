-- ============================================================
-- Phase 2: Add new job_status enum values
-- Must be in its own migration so values commit before being used
-- ============================================================

ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'lead';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'inspection_scheduled';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'inspection_complete';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'emergency_services';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'mitigation_active';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'mitigation_complete';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'estimate_pending';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'estimate_approved';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'reconstruction_active';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'punch_list';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'invoice_submitted';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'payment_pending';
-- 'monitoring' and 'closed' already exist
