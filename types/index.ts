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
  | "uncertain";

export type ReminderType = "uncertain" | "away";

export type PlanType =
  | "trial"
  | "basic_monthly"
  | "standard_monthly"
  | "pro_monthly";

export type ReportLevel = "basic" | "standard" | "advanced";

export type SupervisionIntensity = "high" | "standard" | "low";
export type DataConfidence = "high" | "medium" | "low";

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
  free_rebind_count: number;
  last_rebind_at: string | null;
  rebind_total: number;
  current_device_name: string | null;
  current_device_model: string | null;
  current_device_platform: string | null;
  device_bound_at: string | null;
  status: AccessCodeStatus;
  freeze_reason: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string | null;
  expires_at: string | null;
};

export type DevicePlatform = "Android" | "iOS" | "Windows" | "Mac" | "Other";

export type DeviceInfo = {
  deviceId: string;
  deviceName: string;
  deviceModel: string;
  devicePlatform: DevicePlatform;
};

export type DeviceRebindConfig = {
  rebindCostMinutes: number;
  rebindCooldownHours: number;
  updatedAt: string | null;
  source: "database" | "default";
};

export type DeviceRebindRequired = {
  freeRebindCount: number;
  remainingMinutes: number;
  costMinutes: number;
  cooldownHours: number;
  cooldownRemainingSeconds: number;
  nextRebindAt: string | null;
  isFree: boolean;
};

export type DeviceRebindResult = {
  success: boolean;
  resultCode:
    | "invalid_request"
    | "access_code_not_found"
    | "access_code_unavailable"
    | "first_bound"
    | "already_bound"
    | "cooldown_active"
    | "insufficient_minutes"
    | "rebound"
    | "server_error";
  message: string;
  freeRebindCount: number;
  remainingMinutes: number;
  cooldownRemainingSeconds: number;
  nextRebindAt?: string | null;
  costMinutes: number;
  deductedMinutes: number;
  isFree?: boolean;
  replayed?: boolean;
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
  reminder_type?: ReminderType | null;
  reminder_text?: string | null;
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
  report_token?: string | null;
  status: string | null;
  ip: string | null;
  user_agent: string | null;
  last_active_at: string | null;
  privacy_notice_version?: string | null;
  privacy_acknowledged_at?: string | null;
  created_at: string;
};

export type StudyStats = {
  totalMinutes: number;
  observedMinutes: number;
  dataCoverageRate: number;
  dataConfidence: DataConfidence;
  effectiveMinutes: number;
  uncertainMinutes: number;
  awayMinutes: number;
  focusRate: number;
  studyingCount: number;
  uncertainCount: number;
  thinkingCount: number;
  suspectedDistractedCount: number;
  distractedCount: number;
  awayCount: number;
  lyingCount: number;
  unrelatedCount: number;
  unknownCount: number;
  abnormalCount: number;
  reminderCount: number;
  effectiveReminderCount: number;
  reminderResponseRate: number;
  averageRecoverySeconds: number;
  longestFocusMinutes: number;
};

export type ReportPayload = {
  sessionId: string;
  reportToken: string;
};

export type HabitTrendSession = {
  sessionId: string;
  startTime: string;
  durationMinutes: number;
  averageFocusMinutes: number;
  longestFocusMinutes: number;
  interruptionCount: number;
  reminderCount: number;
  reminderResponseRate: number;
  dataCoverageRate: number;
};

export type HabitTrend = {
  sampleCount: number;
  requiredSampleCount: number;
  isEnoughData: boolean;
  direction: "improving" | "stable" | "declining" | "insufficient";
  summary: string;
  currentAverageFocusMinutes: number;
  previousAverageFocusMinutes: number | null;
  currentLongestFocusMinutes: number;
  averageReminderResponseRate: number;
  sessions: HabitTrendSession[];
};

export type GeneratedReport = {
  stats: StudyStats;
  summary: string;
  conclusion: string;
  parentAdvice: string;
  trend: Record<string, string> | null;
  habitTrend?: HabitTrend | null;
  records: StudyRecord[];
  reportLevel: ReportLevel;
  provider?: string;
  session: {
    id: string;
    startTime: string;
    endTime: string;
    durationMinutes: number | null;
    status: string;
  };
};

export const statusLabels: Record<StudyStatus, string> = {
  studying: "正常学习",
  distracted: "证据不足",
  away: "离座",
  lying: "证据不足",
  unrelated: "证据不足",
  unknown: "证据不足"
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
