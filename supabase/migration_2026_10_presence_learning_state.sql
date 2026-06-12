alter table records add column if not exists presence text default 'present';
alter table records add column if not exists learning_state text default 'unknown';

alter table records drop constraint if exists records_presence_check;
alter table records add constraint records_presence_check
  check (presence in ('present', 'away'));

alter table records drop constraint if exists records_learning_state_check;
alter table records add constraint records_learning_state_check
  check (learning_state in ('studying', 'thinking', 'suspected_distracted', 'unknown'));

update records
set
  presence = case
    when status = 'away' then 'away'
    else 'present'
  end,
  learning_state = case
    when status = 'studying' then 'studying'
    when status in ('distracted', 'unrelated') then 'suspected_distracted'
    else 'unknown'
  end
where presence is null
   or learning_state is null
   or (
    presence = 'present'
    and learning_state = 'unknown'
    and status in ('studying', 'distracted', 'away', 'unrelated')
  );
