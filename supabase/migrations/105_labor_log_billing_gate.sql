-- ============================================================
-- Billing labor gate moves to the QuickBooks Time Labor Log.
-- ------------------------------------------------------------
-- The Daily Construction Log is internal crew notes (not in the
-- packet); billable hours are the ones pulled from QuickBooks Time
-- into the Labor Log. Keeps the DB's canonical required-form matrix
-- in step with the field app's completeness.js.
-- ============================================================

update public.required_forms
   set form_key   = 'laborLog',
       form_label = 'Labor Log (QuickBooks Time)'
 where form_key = 'constructionLogs'
   and template_id = (select id from public.phase_templates where key = 'water_mit');

update public.field_requirements
   set field_path = 'laborLog.entries[].employee',
       label      = 'Crew member on each entry'
 where field_path = 'constructionLogs[].rows[].employee';

update public.field_requirements
   set field_path = 'laborLog.entries[].hours',
       label      = 'Hours synced from QuickBooks Time',
       note       = 'Feeds Board + QBO'
 where field_path = 'constructionLogs[].rows[].hours';
