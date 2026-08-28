// 临时探针:验证 opencode go 端点(连通/鉴权/模型名/max_tokens=32768/流式)。用后即删。
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
const p = { ...cfg.models['GLM-5.3-Flash'] };
if (process.argv[2]) p.model = process.argv[2];
const URL_ = `${p.base_url.replace(/\/+$/, '')}/chat/completions`;
console.log('POST', URL_, '| model =', p.model);

const body = {
  model: p.model,
  max_tokens: p.max_tokens,
  stream: true,
  messages: [{ role: 'user', content: "只回复两个字母:OK" }],
  ...(p.thinking ?? {}),
};

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let res;
try {
  res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.api_key}` },
    body: JSON.stringify(body),
  });
} catch (e) {
  console.error('连接失败:', e?.cause?.code ?? e?.message ?? e);
  process.exit(1);
}
console.log(`[${ts()}] HTTP ${res.status}`);
if (!res.ok) {
  console.error((await res.text()).slice(0, 500));
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '', reasoning = 0, content = 0, finish = null, usage = null, first = null;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    let d; try { d = JSON.parse(payload); } catch { continue; }
    if (first === null) { first = Date.now(); console.log(`[${ts()}] 首 chunk(延迟 ${((first - t0) / 1000).toFixed(1)}s)`); }
    const delta = d.choices?.[0]?.delta ?? {};
    if (delta.reasoning_content) reasoning += delta.reasoning_content.length;
    if (delta.content) content += delta.content.length;
    if (d.choices?.[0]?.finish_reason) finish = d.choices[0].finish_reason;
    if (d.usage) usage = d.usage;
  }
}
console.log(`[${ts()}] 结束: finish=${finish} 思考=${reasoning}字符 回复=${content}字符 usage=${JSON.stringify(usage ?? {})}`);
