export const defaultQwenApiUrl =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

export const visionModelOptions = [
  {
    value: "qwen3.6-flash",
    label: "qwen3.6-flash（当前稳定模型）",
    estimatedCostPerCall: 0.003
  },
  {
    value: "qwen3-vl-flash",
    label: "Qwen3-VL-Flash（低成本候选）",
    estimatedCostPerCall: 0.001
  }
];

