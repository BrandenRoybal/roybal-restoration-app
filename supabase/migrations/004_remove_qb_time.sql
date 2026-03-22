-- Remove QuickBooks Time integration tables and columns
drop table if exists qb_time_jobcodes cascade;
drop table if exists qb_time_tokens cascade;
alter table jobs drop column if exists qb_jobcode_id;
