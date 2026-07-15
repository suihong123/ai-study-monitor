update plan_configs
set
  name = case plan_type
    when 'trial' then '2小时体验版'
    when 'basic_monthly' then '月卡'
    when 'standard_monthly' then '季卡'
    when 'pro_monthly' then '年卡'
    else name
  end,
  daily_minutes = case plan_type
    when 'trial' then 120
    when 'basic_monthly' then 3600
    when 'standard_monthly' then 10800
    when 'pro_monthly' then 43200
    else daily_minutes
  end,
  price_suggest = case plan_type
    when 'trial' then '共2小时监督时长'
    when 'basic_monthly' then '共60小时监督时长'
    when 'standard_monthly' then '共180小时监督时长'
    when 'pro_monthly' then '共720小时监督时长'
    else price_suggest
  end
where plan_type in ('trial', 'basic_monthly', 'standard_monthly', 'pro_monthly');

update access_codes
set daily_minutes = greatest(daily_minutes, total_minutes)
where plan_type in ('trial', 'basic_monthly', 'standard_monthly', 'pro_monthly');
