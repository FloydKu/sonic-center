/**
 * 拆分回复正文中内联的推理内容：部分模型 / 服务（如 Ollama、本地部署的 R1/QwQ）
 * 不使用 reasoning_content 字段，而是把推理过程包在正文开头的 <think>…</think> 中。
 *
 * @returns thinking 推理文本；answer 去掉推理后的正文；open 推理块尚未闭合（仍在思考）
 */
export function splitThinking(content: string): { thinking: string; answer: string; open: boolean } {
  const trimmed = content.trimStart();
  // 流式中途 "<thi" 等不完整开标签：视为思考刚开始，避免把标签碎片显示为正文
  if (trimmed && trimmed.length < 7 && '<think>'.startsWith(trimmed)) {
    return { thinking: '', answer: '', open: true };
  }
  if (!trimmed.startsWith('<think>')) return { thinking: '', answer: content, open: false };
  const body = trimmed.slice('<think>'.length);
  const end = body.indexOf('</think>');
  if (end < 0) return { thinking: body.trim(), answer: '', open: true };
  return {
    thinking: body.slice(0, end).trim(),
    answer: body.slice(end + '</think>'.length).trimStart(),
    open: false,
  };
}
