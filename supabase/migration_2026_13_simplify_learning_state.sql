update records
set learning_state = 'uncertain'
where learning_state in ('thinking', 'suspected_distracted', 'unknown')
   or learning_state is null;

update records
set reminder_type = 'uncertain'
where reminder_type = 'suspected_distracted';

alter table records drop constraint if exists records_learning_state_check;
alter table records add constraint records_learning_state_check
  check (learning_state in ('studying', 'uncertain'));

alter table records drop constraint if exists records_reminder_type_check;
alter table records add constraint records_reminder_type_check
  check (reminder_type is null or reminder_type in ('uncertain', 'away'));
