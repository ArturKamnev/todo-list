import type { AIMode, AssistantMessage, RepeatRule, Task, UserSettings } from "../types";
import { getTodayISO, normalizeScheduledAt } from "../utils/date";
import { defaultRepeat, normalizeRepeat } from "../utils/recurrence";

export type AIConnectionStatus = "idle" | "connected" | "not-connected" | "model-missing";
type StructuredSchema = "create_tasks" | "plan_day" | "create_subtasks";

export interface AIModelInfo {
  name: string;
  modifiedAt?: string;
}

export interface AIConnectionResult {
  status: AIConnectionStatus;
  message: string;
  models: AIModelInfo[];
  selectedModelInstalled: boolean;
  suggestedCommand?: string;
}

export interface AITaskDraft {
  title: string;
  description?: string;
  scheduledAt?: string | null;
  durationMinutes?: number | null;
  repeat?: RepeatRule;
  projectName?: string;
  tags?: string[];
}

export interface CreateTasksAction {
  type: "create_tasks";
  tasks: AITaskDraft[];
}

export type AssistantAction = CreateTasksAction;

export interface AIChatResult {
  message: AssistantMessage;
  action?: AssistantAction;
}

interface PlanBlock {
  time?: string;
  title: string;
  description?: string;
}

interface PlanDayResult {
  userMessage: string;
  plan: PlanBlock[];
}

interface SubtasksResult {
  userMessage: string;
  subtasks: string[];
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "ollama_not_running"
      | "model_missing"
      | "wrong_base_url"
      | "cors_blocked"
      | "unexpected_response"
      | "invalid_ai_response"
      | "provider_not_supported",
    public readonly debug?: Record<string, string | number | boolean | undefined>,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

export async function chatWithAssistant(
  userMessage: string,
  taskContext: Task[],
  settings: UserSettings,
  mode: AIMode,
): Promise<AIChatResult> {
  if (mode === "plan_day") {
    const raw = await requestOllamaChat(settings, [
      { role: "system", content: buildPlanPrompt(taskContext, settings.language) },
      { role: "user", content: userMessage },
    ], { json: true });
    const plan = await parseOrRepairStructured(raw, "plan_day", settings, validatePlanDayResult);
    return {
      message: createAssistantMessage(renderPlanMessage(plan, settings.language)),
    };
  }

  const raw = await requestOllamaChat(settings, [
    { role: "system", content: buildCreateTasksPrompt(taskContext, settings.language) },
    { role: "user", content: userMessage },
  ], { json: true });
  const action = await parseOrRepairStructured(raw, "create_tasks", settings, validateCreateTasksAction);

  return {
    message: createAssistantMessage(renderCreateTasksMessage(action.action.tasks.length, settings.language), { actionType: action.action.type }),
    action: action.action,
  };
}

export async function breakDownTaskWithAI(task: Task, settings: UserSettings): Promise<string[]> {
  const raw = await requestOllamaChat(settings, [
    { role: "system", content: buildBreakdownPrompt(task, settings.language) },
    { role: "user", content: `Break this task into practical subtasks: ${task.title}\n\n${task.description}` },
  ], { json: true });

  const result = await parseOrRepairStructured(raw, "create_subtasks", settings, validateSubtasksResult);
  return result.subtasks;
}

export async function testOllamaConnection(settings: UserSettings): Promise<AIConnectionResult> {
  const endpoint = `${normalizeBaseUrl(settings.aiBaseUrl)}/api/tags`;
  logAIDebug("Testing Ollama connection", {
    provider: settings.aiProvider,
    baseUrl: settings.aiBaseUrl,
    model: settings.localModel,
    endpoint,
  });

  if (settings.aiProvider !== "ollama") {
    throw new AIProviderError("Only Local Ollama is configured in this build.", "provider_not_supported", {
      provider: settings.aiProvider,
    });
  }

  const response = await fetchWithProviderErrors(endpoint, { method: "GET" }, settings);

  logAIDebug("Ollama connection response", {
    provider: settings.aiProvider,
    baseUrl: settings.aiBaseUrl,
    model: settings.localModel,
    endpoint,
    status: response.status,
  });

  if (!response.ok) {
    throw new AIProviderError("Could not connect to the AI provider. Check the Ollama Base URL in Settings.", "wrong_base_url", {
      provider: settings.aiProvider,
      baseUrl: settings.aiBaseUrl,
      model: settings.localModel,
      endpoint,
      status: response.status,
    });
  }

  const payload = (await response.json()) as unknown;
  const models = readOllamaModels(payload);
  const selectedModelInstalled = models.some((model) => modelMatches(model.name, settings.localModel));

  return {
    status: selectedModelInstalled ? "connected" : "model-missing",
    message: selectedModelInstalled ? "Connected" : `Model not found. Run: ollama pull ${settings.localModel}`,
    models,
    selectedModelInstalled,
    suggestedCommand: selectedModelInstalled ? undefined : `ollama pull ${settings.localModel}`,
  };
}

async function requestOllamaChat(
  settings: UserSettings,
  messages: Array<{ role: "system" | "user"; content: string }>,
  options: { json?: boolean } = {},
) {
  if (settings.aiProvider !== "ollama") {
    throw new AIProviderError("Only Local Ollama is configured in this build.", "provider_not_supported", {
      provider: settings.aiProvider,
    });
  }

  const endpoint = `${normalizeBaseUrl(settings.aiBaseUrl)}/api/chat`;
  logAIDebug("Sending Ollama chat request", {
    provider: settings.aiProvider,
    baseUrl: settings.aiBaseUrl,
    model: settings.localModel,
    endpoint,
    format: options.json ? "json" : "text",
  });

  const response = await fetchWithProviderErrors(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.localModel,
      messages,
      stream: false,
      ...(options.json ? { format: "json" } : {}),
    }),
  }, settings);

  logAIDebug("Ollama chat response", {
    provider: settings.aiProvider,
    baseUrl: settings.aiBaseUrl,
    model: settings.localModel,
    endpoint,
    status: response.status,
  });

  if (response.status === 404) {
    throw new AIProviderError(`Model not found. Run: ollama pull ${settings.localModel}`, "model_missing", {
      provider: settings.aiProvider,
      baseUrl: settings.aiBaseUrl,
      model: settings.localModel,
      endpoint,
      status: response.status,
    });
  }

  if (!response.ok) {
    const body = await readResponseText(response);
    const isMissingModel = body.toLowerCase().includes("model") && (body.toLowerCase().includes("not found") || body.toLowerCase().includes("pull"));
    if (isMissingModel) {
      throw new AIProviderError(`Model not found. Run: ollama pull ${settings.localModel}`, "model_missing", {
        provider: settings.aiProvider,
        baseUrl: settings.aiBaseUrl,
        model: settings.localModel,
        endpoint,
        status: response.status,
      });
    }
    throw new AIProviderError("Could not connect to the AI provider. Check the Ollama Base URL in Settings.", "wrong_base_url", {
      provider: settings.aiProvider,
      baseUrl: settings.aiBaseUrl,
      model: settings.localModel,
      endpoint,
      status: response.status,
    });
  }

  const payload = (await response.json()) as unknown;
  return readOllamaMessage(payload);
}

async function parseOrRepairStructured<T>(
  raw: string,
  schema: StructuredSchema,
  settings: UserSettings,
  validate: (value: unknown) => T | undefined,
): Promise<T> {
  const parsed = parseStructured(raw, validate, schema, settings.language);
  if (parsed) return parsed;

  logInvalidAIResponse(raw, schema, "initial");
  const repaired = await repairStructuredResponse(raw, schema, settings);
  const repairedParsed = parseStructured(repaired, validate, schema, settings.language);
  if (repairedParsed) return repairedParsed;

  logInvalidAIResponse(repaired, schema, "repair");
  throw new AIProviderError("I could not understand the AI response. Please try again.", "invalid_ai_response", {
    schema,
  });
}

function parseStructured<T>(
  raw: string,
  validate: (value: unknown) => T | undefined,
  schema: StructuredSchema,
  language: UserSettings["language"],
) {
  const candidates = extractJsonCandidates(raw);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const valid = validate(parsed);
      if (valid && isLanguageSafeStructured(valid, schema, language)) return valid;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function repairStructuredResponse(raw: string, schema: StructuredSchema, settings: UserSettings) {
  return requestOllamaChat(settings, [
    { role: "system", content: buildRepairPrompt(schema, settings.language) },
    { role: "user", content: raw },
  ], { json: true });
}

function buildPlanPrompt(taskContext: Task[], language: UserSettings["language"]) {
  return `${baseStructuredPrompt(taskContext, language)}
Mode: plan_day.
Return one valid JSON object only:
{
  "userMessage": "${copy(language).planUserMessage}",
  "plan": [
    { "time": "09:00", "title": "Focused work", "description": "Work on the most important task." }
  ]
}

Rules:
- Use 3 to 8 plan blocks.
- Prefer the user's existing scheduled times and durations.
- If a time is unknown, omit time instead of inventing one.
- Keep titles and descriptions practical. No motivational filler.
- time may be omitted when the user did not provide enough time context.
- Do not create tasks or claim anything was saved.`;
}

function buildCreateTasksPrompt(taskContext: Task[], language: UserSettings["language"]) {
  return `${baseStructuredPrompt(taskContext, language)}
Mode: create_tasks.
Extract tasks from the user's description. Return one valid JSON object only:
{
  "userMessage": "${copy(language).createTasksUserMessage}",
  "action": {
    "type": "create_tasks",
    "tasks": [
      {
        "title": "Wash clothes",
        "description": "",
        "scheduledAt": "2026-05-16T18:30",
        "durationMinutes": 30,
        "repeat": {
          "enabled": false,
          "type": "daily",
          "interval": 1,
          "unit": "day",
          "weekdays": [],
          "excludedWeekdays": []
        },
        "projectName": "Personal",
        "tags": []
      }
    ]
  }
}

Rules:
- action.type must be "create_tasks".
- scheduledAt may be null, "YYYY-MM-DD", or "YYYY-MM-DDTHH:mm".
- durationMinutes must be null or a positive integer when the user gives an estimate.
- repeat is optional. Use it only when the user explicitly mentions recurrence.
- For weekdays use 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
- For every weekday use weekdays [1,2,3,4,5]. For weekend use [0,6]. For every day except Sunday use type daily and excludedWeekdays [0].
- Use exact hours and minutes when the user gives a time.
- If the user says tomorrow, resolve from current date ${getTodayISO()}.
- Do not infer private details, categories, deadlines, or durations that the user did not provide.
- Do not claim tasks were created. The app creates them after user confirmation.`;
}

function buildBreakdownPrompt(task: Task, language: UserSettings["language"]) {
  return `You are Todo AI inside a desktop task app.
${languageInstruction(language)}
Return one valid JSON object only:
{
  "userMessage": "${copy(language).subtasksUserMessage}",
  "subtasks": ["First concrete step", "Second concrete step"]
}

Rules:
- Generate 3 to 7 concrete subtasks.
- Subtasks must be short action phrases.
- Use only information from the task. Do not invent external requirements.
- Do not claim subtasks were saved.

Task title: ${task.title}
Task description: ${task.description || "No description."}`;
}

function buildRepairPrompt(schema: StructuredSchema, language: UserSettings["language"]) {
  const shape =
    schema === "create_tasks"
      ? `{"userMessage":"${copy(language).createTasksUserMessage}","action":{"type":"create_tasks","tasks":[{"title":"Task title","description":"","scheduledAt":null,"durationMinutes":null,"repeat":{"enabled":false,"type":"daily","interval":1,"unit":"day","weekdays":[],"excludedWeekdays":[]},"projectName":"Personal","tags":[]}]}}`
      : schema === "plan_day"
        ? `{"userMessage":"${copy(language).planUserMessage}","plan":[{"time":"09:00","title":"Plan item","description":"What to do."}]}`
        : `{"userMessage":"${copy(language).subtasksUserMessage}","subtasks":["First step","Second step","Third step"]}`;

  return `Convert the user's content into valid JSON for Todo AI.
${languageInstruction(language)}
Return only one JSON object. No markdown fences. No commentary.
Required schema:
${shape}`;
}

function baseStructuredPrompt(taskContext: Task[], language: UserSettings["language"]) {
  const taskSummary = taskContext
    .slice(0, 20)
    .map((task) => `- ${task.title} | status=${task.status} | scheduledAt=${task.scheduledAt ?? "none"} | duration=${task.durationMinutes ?? "none"} | repeat=${task.repeat.enabled ? "yes" : "no"}`)
    .join("\n");

  return `You are Todo AI, a practical desktop productivity assistant.
Current date: ${getTodayISO()}.
${languageInstruction(language)}
Follow the selected mode strictly. Keep wording concise and useful. Ask for clarification only when the request cannot be completed safely.
Never return markdown fences. Never show raw JSON to the user. Never invent that app state changed.
Only return structured data for the internal action schema requested by the system.
Current tasks:
${taskSummary || "No tasks yet."}`;
}

async function fetchWithProviderErrors(endpoint: string, init: RequestInit, settings: UserSettings) {
  try {
    return await fetch(endpoint, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isLocalOllama = endpoint.startsWith("http://localhost") || endpoint.startsWith("http://127.0.0.1");
    const isCorsLike = !isLocalOllama && (message.toLowerCase().includes("cors") || message.toLowerCase().includes("failed to fetch"));
    const aiError = new AIProviderError(
      isCorsLike
        ? "Ollama blocked the request. Add this app origin to OLLAMA_ORIGINS and restart Ollama."
        : "Ollama is not running. Start Ollama and try again.",
      isCorsLike ? "cors_blocked" : "ollama_not_running",
      {
        provider: settings.aiProvider,
        baseUrl: settings.aiBaseUrl,
        model: settings.localModel,
        endpoint,
        error: message,
      },
    );
    logAIError(aiError);
    throw aiError;
  }
}

function validateCreateTasksAction(value: unknown): { userMessage: string; action: CreateTasksAction } | undefined {
  if (!isRecord(value)) return undefined;
  const userMessage = readUserMessage(value) || "Review these tasks before creating them.";
  const action = isRecord(value.action) ? value.action : value;
  if (action.type !== "create_tasks" || !Array.isArray(action.tasks)) return undefined;
  const tasks = action.tasks.map(readTaskDraft).filter((task): task is AITaskDraft => Boolean(task));
  return tasks.length > 0 ? { userMessage, action: { type: "create_tasks", tasks } } : undefined;
}

function validatePlanDayResult(value: unknown): PlanDayResult | undefined {
  if (!isRecord(value)) return undefined;
  const planSource = Array.isArray(value.plan) ? value.plan : Array.isArray(value.blocks) ? value.blocks : Array.isArray(value.schedule) ? value.schedule : undefined;
  if (!planSource) return undefined;
  const plan = planSource.map(readPlanBlock).filter((block): block is PlanBlock => Boolean(block)).slice(0, 8);
  if (plan.length === 0) return undefined;
  return {
    userMessage: readUserMessage(value) || "Here is a practical plan for your day.",
    plan,
  };
}

function validateSubtasksResult(value: unknown): SubtasksResult | undefined {
  if (!isRecord(value)) return undefined;
  const rawSubtasks = Array.isArray(value.subtasks) ? value.subtasks : Array.isArray(value.tasks) ? value.tasks : undefined;
  if (!rawSubtasks) return undefined;
  const subtasks = rawSubtasks
    .map(readSubtaskTitle)
    .filter((title): title is string => Boolean(title))
    .slice(0, 7);
  return subtasks.length >= 3
    ? { userMessage: readUserMessage(value) || "Here is a smaller checklist.", subtasks }
    : undefined;
}

function readTaskDraft(value: unknown): AITaskDraft | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || value.title.trim().length === 0) return undefined;
  const scheduleValue = readScheduleValue(value);
  return {
    title: value.title.trim(),
    description: typeof value.description === "string" ? value.description.trim() : "",
    scheduledAt: normalizeScheduledAt(scheduleValue),
    durationMinutes: readDurationMinutes(value.durationMinutes),
    repeat: isRecord(value.repeat) ? normalizeRepeat(value.repeat) : { ...defaultRepeat },
    projectName: typeof value.projectName === "string" && value.projectName.trim() ? value.projectName.trim() : undefined,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean) : [],
  };
}

function readPlanBlock(value: unknown): PlanBlock | undefined {
  if (typeof value === "string" && value.trim()) return { title: value.trim() };
  if (!isRecord(value)) return undefined;
  const titleValue = value.title ?? value.task ?? value.label;
  if (typeof titleValue !== "string" || !titleValue.trim()) return undefined;
  return {
    time: typeof value.time === "string" && value.time.trim() ? value.time.trim() : undefined,
    title: titleValue.trim(),
    description: typeof value.description === "string" && value.description.trim() ? value.description.trim() : undefined,
  };
}

function readSubtaskTitle(value: unknown) {
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  const titleValue = value.title ?? value.task ?? value.name;
  return typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : undefined;
}

function readScheduleValue(value: Record<string, unknown>) {
  const direct = value.scheduledAt ?? value.dueAt ?? value.deadline;
  if (typeof direct === "string" || direct === null) return direct;

  const date = typeof value.date === "string" ? value.date : "";
  const time = typeof value.time === "string" ? value.time : "";
  if (!date) return null;
  return time ? `${date}T${time}` : date;
}

function renderPlanMessage(plan: PlanDayResult, language: UserSettings["language"]) {
  const items = plan.plan.map((item) => {
    const prefix = item.time ? `${item.time} ` : "";
    const description = item.description ? `: ${item.description}` : "";
    return `${prefix}${item.title}${description}`;
  });
  return [sanitizeAssistantText(plan.userMessage, copy(language).planUserMessage), ...items.map((item) => `- ${item}`)].join("\n");
}

function renderCreateTasksMessage(count: number, language: UserSettings["language"]) {
  if (language === "ru") {
    return count === 1 ? "Я нашел 1 задачу. Проверьте ее перед созданием." : `Я нашел ${count} задач. Проверьте их перед созданием.`;
  }
  return count === 1 ? "I found 1 task. Review it before creating it." : `I found ${count} tasks. Review them before creating them.`;
}

function sanitizeAssistantText(value: string, fallback: string) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.includes("{") || trimmed.includes("}") || trimmed.includes("[") || trimmed.includes("]")) return fallback;
  if (hasCjkCharacters(trimmed)) return fallback;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237).trim()}...` : trimmed;
}

function readDurationMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function readOllamaMessage(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "object" &&
    payload.message !== null &&
    "content" in payload.message &&
    typeof payload.message.content === "string"
  ) {
    return payload.message.content.trim();
  }

  throw new AIProviderError("The AI provider returned an unexpected response.", "unexpected_response");
}

function readOllamaModels(payload: unknown): AIModelInfo[] {
  if (isRecord(payload) && Array.isArray(payload.models)) {
    return payload.models
      .filter((model): model is { name: string; modified_at?: string } => {
        return isRecord(model) && typeof model.name === "string";
      })
      .map((model) => ({ name: model.name, modifiedAt: model.modified_at }));
  }

  throw new AIProviderError("The AI provider returned an unexpected response.", "unexpected_response");
}

function extractJsonCandidates(content: string) {
  const trimmed = stripCodeFence(content.trim());
  const candidates = new Set<string>();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.add(trimmed);

  const balanced = extractBalancedObjects(trimmed);
  balanced.forEach((candidate) => candidates.add(stripCodeFence(candidate)));
  return [...candidates];
}

function extractBalancedObjects(content: string) {
  const results: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return results;
}

function stripCodeFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function readUserMessage(value: Record<string, unknown>) {
  if (typeof value.userMessage === "string" && value.userMessage.trim()) return value.userMessage.trim();
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return "";
}

async function readResponseText(response: Response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function createAssistantMessage(content: string, metadata?: AssistantMessage["metadata"]): AssistantMessage {
  return {
    id: `message-${Date.now()}-assistant`,
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
    metadata,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function modelMatches(installedModel: string, selectedModel: string) {
  return installedModel === selectedModel || installedModel.replace(/:latest$/, "") === selectedModel || selectedModel.replace(/:latest$/, "") === installedModel;
}

function isLanguageSafeStructured(value: unknown, schema: StructuredSchema, _language: UserSettings["language"]) {
  if (hasCjkCharacters(JSON.stringify(value))) return false;
  if (schema === "plan_day" && isRecord(value)) {
    return typeof value.userMessage !== "string" || !hasCjkCharacters(value.userMessage);
  }
  return true;
}

function hasCjkCharacters(value: string) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function languageInstruction(language: UserSettings["language"]) {
  if (language === "ru") {
    return [
      "Response language: Russian only.",
      "All user-facing strings inside JSON must be Russian.",
      "Do not answer in English, Chinese, Japanese, or any other language unless the user explicitly asks to translate text.",
    ].join("\n");
  }

  return [
    "Response language: English only.",
    "All user-facing strings inside JSON must be English.",
    "Do not answer in Russian, Chinese, Japanese, or any other language unless the user explicitly asks to translate text.",
  ].join("\n");
}

function copy(language: UserSettings["language"]) {
  return language === "ru"
    ? {
      planUserMessage: "Вот практичный план на день.",
      createTasksUserMessage: "Я нашел задачи. Проверьте их перед созданием.",
      subtasksUserMessage: "Вот короткий список подзадач.",
    }
    : {
      planUserMessage: "Here is a practical plan for your day.",
      createTasksUserMessage: "I found tasks. Review them before creating them.",
      subtasksUserMessage: "Here is a smaller checklist.",
    };
}

function logAIDebug(message: string, data: Record<string, string | number | boolean | undefined>) {
  if (import.meta.env.DEV) {
    console.info(`[Todo AI] ${message}`, data);
  }
}

function logAIError(error: AIProviderError) {
  if (import.meta.env.DEV) {
    console.error("[Todo AI] AI provider error", {
      code: error.code,
      message: error.message,
      ...error.debug,
    });
  }
}

function logInvalidAIResponse(rawResponse: string, schema: StructuredSchema, phase: "initial" | "repair") {
  if (import.meta.env.DEV) {
    console.error("[Todo AI] Invalid AI response", { schema, phase, rawResponse });
  }
}
