// 流式探针:取 16 局红方第 6 步的真实请求体(debug log 最后一条 player-request),
// 改 stream:true 发给 GLM coding 端点,记录 SSE 时间线,验证「流式不触发 5 分钟空闲掐断」。
// 用法: node scripts/probe-stream.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cfg = require('../config.json');

const DEBUG_FILE = 'D:/APP/llm_pk/games/xiangqi/debug_logs/20260828-GLM-5-3-Flash-pk-deepseek-v4-flash-16_GLM-5-3-Flash.jsonl';
const profile = cfg.models['GLM-5.3-Flash'];
const URL_ = `${profile.base_url}/chat/completions`;

// 提取最后一条 player-request 的 body
const lines = readFileSync(DEBUG_FILE, 'utf-8').trim().split('\n');
let body = null;
for (const l of lines) {
  try {
    const d = JSON.parse(l);
    if (d.kind === 'player-request' && d.body) body = d.body;
  } catch {}
}
if (!body) { console.error('未找到 player-request'); process.exit(1); }

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
console.log(`[${ts()}] 请求发出 model=${body.model} effort=${body.reasoning_effort} max_tokens=${body.max_tokens} stream=true`);

const res = await fetch(URL_, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${profile.api_key}` },
  body: JSON.stringify({ ...body, stream: true }),
});
console.log(`[${ts()}] HTTP ${res.status}`);

if (!res.ok) { console.error(await res.text()); process.exit(1); }

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
let reasoningChars = 0, contentChars = 0, toolArgs = '', chunkCount = 0, lastDataAt = Date.now();
let finishReason = null, usage = null, firstChunkAt = null;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const events = buf.split('\n');
  buf = events.pop() ?? '';
  for (const line of events) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { console.log(`[${ts()}] [DONE]`); continue; }
    let d; try { d = JSON.parse(payload); } catch { continue; }
    chunkCount++;
    if (firstChunkAt === null) { firstChunkAt = Date.now(); console.log(`[${ts()}] 首 chunk 到达(连接活跃,空闲计时重置)`); }
    lastDataAt = Date.now();
    const delta = d.choices?.[0]?.delta ?? {};
    if (delta.reasoning_content) { reasoningChars += delta.reasoning_content.length; }
    if (delta.content) { contentChars += delta.reasoning_content ? 0 : delta.content.length; }
    if (delta.tool_calls?.[0]?.function?.arguments) { toolArgs += delta.tool_calls[0].function.arguments; }
    if (d.choices?.[0]?.finish_reason) { finishReason = d.choices[0].finish_reason; console.log(`[${ts()}] finish_reason=${finishReason}`); }
    if (d.usage) usage = d.usage;
    if (chunkCount % 50 === 0) console.log(`[${ts()}] 已收 ${chunkCount} chunks, 思考累计 ${reasoningChars} 字符`);
  }
}
console.log(`[${ts()}] 流结束`);
console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | chunks=${chunkCount} | 思考=${reasoningChars}字符 | tool参数=${toolArgs.length}字符 | finish=${finishReason}`);
if (toolArgs) {
  try {
    const parsed = JSON.parse(toolArgs);
    console.log('出招:', JSON.stringify({ analysis: (parsed.analysis || '').slice(0, 80) + '…', move: parsed.move }));
  } catch { console.log('tool 参数非完整 JSON(截断?)'); }
}
if (usage) console.log('usage:', JSON.stringify(usage));
