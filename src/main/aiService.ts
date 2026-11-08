import * as path from 'path';
import { promises as fs } from 'fs';
import { app } from 'electron';
import type { AiConfig, AiChatMessage, AiTestResult } from '../shared/types';

/**
 * AI 服务（OpenAI 兼容接口）：配置持久化 + 连接测试 + 流式对话。
 * 使用 Node 20 全局 fetch，无需额外 npm 依赖。
 */

const CONFIG_FILE = 'ai-config.json';

const DEFAULT_CONFIG: AiConfig = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
};

/** 规范化配置：去首尾空白、baseURL 去尾部斜杠 */
function normalizeConfig(config: Partial<AiConfig>): AiConfig {
  return {
    baseURL: (config.baseURL ?? '').trim().replace(/\/+$/, ''),
    apiKey: (config.apiKey ?? '').trim(),
    model: (config.model ?? '').trim(),
  };
}

function configFilePath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

/** 读取已保存的 AI 配置（不存在或损坏时返回默认值） */
export async function loadAiConfig(): Promise<AiConfig> {
  try {
    const raw = await fs.readFile(configFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    // 保留已填字段，缺失字段回退默认值，避免空字符串覆盖
    return {
      baseURL: parsed.baseURL?.trim() || DEFAULT_CONFIG.baseURL,
      apiKey: parsed.apiKey?.trim() ?? '',
      model: parsed.model?.trim() || DEFAULT_CONFIG.model,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** 保存 AI 配置到 userData/ai-config.json */
export async function saveAiConfig(config: Partial<AiConfig>): Promise<AiConfig> {
  const normalized = normalizeConfig(config);
  await fs.writeFile(configFilePath(), JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

// ----------------------------- HTTP 错误友好化 -----------------------------

/** 把 fetch / HTTP 状态错误翻译成用户可读的提示 */
async function explainHttpError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    detail = '';
  }
  const suffix = detail ? `：${detail}` : '';
  switch (res.status) {
    case 401:
      return `API Key 无效或未授权${suffix}`;
    case 404:
      return `接口地址或模型不存在，请检查 API 地址与模型名${suffix}`;
    case 429:
      return `请求过于频繁或额度不足${suffix}`;
    default:
      return `服务返回错误 ${res.status}${suffix}`;
  }
}

// ----------------------------- 连接测试 -----------------------------

/** 测试连接：发送一条极小的非流式请求，验证地址 / Key / 模型可用 */
export async function testAiConnection(config: Partial<AiConfig>): Promise<AiTestResult> {
  const c = normalizeConfig(config);
  if (!c.baseURL) return { ok: false, message: '请填写 API 地址' };
  if (!c.model) return { ok: false, message: '请填写模型名' };
  if (!c.apiKey) return { ok: false, message: '请填写 API Key' };

  try {
    const res = await fetch(`${c.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({
        model: c.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, message: await explainHttpError(res) };
    // 校验响应结构，防止 URL 指向了非 OpenAI 兼容服务
    const data = (await res.json()) as { choices?: unknown[] };
    if (!Array.isArray(data.choices)) {
      return { ok: false, message: '响应格式不符合 OpenAI 兼容接口，请检查 API 地址' };
    }
    return { ok: true, message: `连接成功，模型 ${c.model} 可用` };
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError') return { ok: false, message: '连接超时（15 秒），请检查网络或 API 地址' };
    return { ok: false, message: `网络错误：${err.message}` };
  }
}

// ----------------------------- 流式对话 -----------------------------

/** 当前会话的中止控制器（同一时间仅允许一个对话流） */
let activeController: AbortController | null = null;

/** 中止当前进行中的对话流（无进行中的流则静默） */
export function cancelAiChat(): void {
  activeController?.abort();
  activeController = null;
}

/** 流式增量：正文与推理内容分开推送 */
export interface AiStreamDelta {
  content?: string;
  reasoning?: string;
}

/**
 * SSE 流中的一行 data 载荷。
 * 推理内容字段各家不一：DeepSeek / 通义 / 硅基流动等为 reasoning_content，OpenRouter / Ollama 等为 reasoning
 */
interface SseMessage {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
}
interface SseChunk {
  choices?: Array<{ delta?: SseMessage; message?: SseMessage }>;
}

function pickDelta(m: SseMessage | undefined): AiStreamDelta {
  return {
    content: m?.content || undefined,
    reasoning: m?.reasoning_content || m?.reasoning || undefined,
  };
}

/**
 * 流式对话：POST {baseURL}/chat/completions (stream: true)，
 * 逐块解析 SSE 并通过 onDelta 推送增量正文 / 推理内容，结束时 resolve 完整回复。
 * 部分兼容服务不返回 SSE，此时回退解析普通 JSON 响应。
 *
 * @param messages 完整消息列表（含 system prompt）
 * @param onDelta  每收到一段增量回调一次
 * @returns 完整回复正文；出错抛出友好错误
 */
export async function streamAiChat(
  config: Partial<AiConfig>,
  messages: AiChatMessage[],
  onDelta: (delta: AiStreamDelta) => void,
): Promise<string> {
  const c = normalizeConfig(config);
  if (!c.baseURL || !c.model) throw new Error('AI 服务未配置，请先到 设置 → AI 服务 完成配置');
  if (!c.apiKey) throw new Error('API Key 未配置，请先到 设置 → AI 服务 完成配置');

  // 单会话锁：新对话开始前中止旧流
  cancelAiChat();
  const controller = new AbortController();
  activeController = controller;

  let full = '';
  try {
    const res = await fetch(`${c.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({ model: c.model, messages, stream: true }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(await explainHttpError(res));
    if (!res.body) throw new Error('服务未返回响应体');

    // SSE 的 content-type 通常是 text/event-stream；若是 JSON 则按非流式解析
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as SseChunk;
      const delta = pickDelta(data.choices?.[0]?.message);
      if (delta.content || delta.reasoning) onDelta(delta);
      full = delta.content ?? '';
      return full;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔，逐行处理完整行
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // 末行可能不完整，留到下一块
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          return full;
        }
        try {
          const chunk = JSON.parse(payload) as SseChunk;
          // OpenAI 流式增量在 delta；个别服务非流式返回在 message
          const choice = chunk.choices?.[0];
          const delta = pickDelta(choice?.delta ?? choice?.message);
          if (delta.content || delta.reasoning) {
            full += delta.content ?? '';
            onDelta(delta);
          }
        } catch {
          // 心跳/注释等非 JSON 行，跳过
        }
      }
    }
    return full;
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new Error('已停止生成');
    if (err.name === 'TimeoutError') throw new Error('连接超时，请检查网络或 API 地址');
    throw err;
  } finally {
    if (activeController === controller) activeController = null;
  }
}
