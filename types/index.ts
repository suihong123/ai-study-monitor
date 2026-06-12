export type StudyStatus =
  | "studying"
  | "distracted"
  | "away"
  | "lying"
  | "unrelated"
  | "unknown";

export type Presence = "present" | "away";

export type LearningState =
  | "studying"
  | "thinking"
  | "suspected_distracted"
  | "unknown";

export type PlanType =
  | "trial"
  | "basic_monthly"
  | "standard_monthly"
  | "pro_monthly";

export type ReportLevel = "basic" | "standard" | "advanced";

export type SupervisionIntensity = "high" | "standard" | "low";

export type AccessCodeStatus =
  | "active"
  | "watch"
  | "paused"
  | "refunded"
  | "expired"
  | "disabled"
  | "blacklist";

export type AccessCode = {
  id: string;
  code: string;
  plan_type: PlanType;
  total_minutes: number;
  used_minutes: number;
  daily_minutes: number;
  used_minutes_today: number;
  last_reset_date: string | null;
  report_level: ReportLevel;
  base_interval_seconds: number;
  min_interval_seconds: number;
  device_id: string | null;
  status: AccessCodeStatus;
  freeze_reason: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string | null;
  expires_at: string | null;
};

export type PlanConfig = {
  id: string;
  plan_type: PlanType;
  name: string;
  daily_minutes: number;
  base_interval_seconds: number;
  min_interval_seconds: number;
  report_level: ReportLevel;
  price_suggest: string;
  created_at: string;
};

export type StudyRecord = {
  id?: string;
  session_id?: string;
  status: StudyStatus;
  timestamp: string;
  confidence?: number | null;
  reason?: string | null;
  analyze_mode?: string;
  presence?: Presence;
  learning_state?: LearningState;
  current_frequency_seconds?: number;
  frequency_boosted_by_abnormal?: boolean;
  frequency_lowered_by_focus?: boolean;
  triggered_reminder?: boolean;
  ai_called?: boolean;
  error_message?: string | null;
  manual_corrected?: boolean;
  correction_source?: string | null;
  corrected_at?: string | null;
};

export type StudySession = {
  id: string;
  access_code_id: string;
  start_time: string;
  end_time: string | null;
  duration_minutes: number | null;
  focus_rate: number | null;
  ai_call_count: number | null;
  estimated_cost: number | null;
  report_level: ReportLevel | null;
  session_token: string | null;
  status: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
};

export type StudyStats = {
  totalMinutes: number;
  effectiveMinutes: number;
  focusRate: number;
  studyingCount: number;
  thinkingCount: number;
  suspectedDistractedCount: number;
  distractedCount: number;
  awayCount: number;
  lyingCount: number;
  unrelatedCount: number;
  unknownCount: number;
  abnormalCount: number;
  reminderCount: number;
  longestFocusMinutes: number;
};

export type ReportPayload = {
  sessionId: string;
  accessCodeId: string;
  sessionToken: string;
  records: StudyRecord[];
  startTime: string;
  endTime: string;
  stats: StudyStats;
  reportLevel: ReportLevel;
};

export const statusLabels: Record<StudyStatus, string> = {
  studying: "正常学习",
  distracted: "疑似走神",
  away: "离座",
  lying: "趴桌",
  unrelated: "玩无关物品",
  unknown: "无法判断"
};

export const abnormalStatuses: StudyStatus[] = [
  "distracted",
  "away",
  "lying",
  "unrelated"
];

export const intensityLabels: Record<SupervisionIntensity, string> = {
  high: "高频监督",
  standard: "标准监督",
  low: "低频监督"
};
