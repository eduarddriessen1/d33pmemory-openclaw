export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    apiUrl: { type: "string", description: "d33pmemory API base URL", default: "https://api.d33pmemory.com" },
    apiKey: { type: "string", description: "Your d33pmemory API key (dm_xxx)" },
    agentId: { type: "string", description: "Default agent name for ingest/recall" },
    autoIngest: { type: "boolean", description: "Auto-ingest every conversation turn", default: true },
    autoRecall: { type: "boolean", description: "Auto-recall memories on session start", default: true },
    recallQuery: { type: "string", description: "Default recall query" },
    recallMaxResults: { type: "number", description: "Max memories to recall", default: 10, minimum: 1, maximum: 50 },
    recallMinConfidence: { type: "number", description: "Min confidence for recall", default: 0.3, minimum: 0, maximum: 1 },
    source: { type: "string", description: "Source label for ingested interactions", default: "openclaw" },
  },
  required: ["apiKey"],
};
