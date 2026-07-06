create table if not exists ai_model_configs (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'qwen' check (provider in ('qwen')),
  mode text not null default 'qwen' check (mode in ('mock', 'qwen')),
  model text not null,
  api_url text not null,
  estimated_cost_per_call numeric(10, 4) not null default 0.003,
  is_active boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create unique index if not exists idx_ai_model_configs_one_active_provider
  on ai_model_configs(provider)
  where is_active = true;

insert into ai_model_configs (
  provider,
  mode,
  model,
  api_url,
  estimated_cost_per_call,
  is_active,
  notes,
  updated_at
) values (
  'qwen',
  'qwen',
  'qwen3.6-flash',
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  0.003,
  true,
  '默认稳定模型，可在后台切换为 qwen3-vl-flash 进行低成本测试。',
  now()
)
on conflict do nothing;

alter table ai_model_configs enable row level security;

-- 本表只允许服务端通过 Supabase service role 读写，不开放浏览器端直连权限。

