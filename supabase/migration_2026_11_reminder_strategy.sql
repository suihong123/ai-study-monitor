alter table records add column if not exists reminder_type text;
alter table records add column if not exists reminder_text text;

alter table records drop constraint if exists records_reminder_type_check;
alter table records add constraint records_reminder_type_check
  check (reminder_type is null or reminder_type in ('suspected_distracted', 'away'));
