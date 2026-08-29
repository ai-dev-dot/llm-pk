// 临时探针:验证「阶段① 列3候选」在真实档位下的推理量是否可控(分步方案的核心假设)。
// 用法: node scripts/probe-stages.mjs <GLM-5.3|deepseek-v4-pro|...>
// 输出:各阶段的 finish_reason / 推理字符数 / completion tokens / 耗时 -- 判断小任务是否快收敛。
import { readFileSync } from 'node:fs';
const name = process.argv[2] ?? 'GLM-5.3';
const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
const p = cfg.models[name];
if (!p) { console.error(`config.models 无此 profile: ${name}`); process.exit(2); }

const URL_ = p.base_url.replace(/\/+$/, '') + '/chat/completions';

// 复刻 arena 真实上下文:取一个中局局面(08局第7步后)的 user prompt 结构
const BOARD = `当前局面(下方为红方、第 1 行;上方为黑方、第 10 行)。现在轮到红方走棋:

    a   b   c   d   e   f   g   h   i
10  [車] .   [象] [士] [將] [士] [象] [馬] [車]  黑(顶)
 9  .   .   .   .   .   .   .   .   [士]  .
 8  .   .   .   .   [士] .   .   .   .
 7  [卒] .   [卒] .   .   [卒] .   [卒] [卒]
 6  .   .   .   .   .   .   .   .   .
 5  ───────────── 楚 河 漢 界 ─────────────
 4  [兵] .   [兵] .   [兵] .   [兵] .   [兵]
 3  .   [砲] .   .   .   .   [馬] .   .
 2  .   .   .   .   .   .   [馬] .   .
 1  [車] .   [象] [士] [帥] .   .   [卒] .
`;

const RULES_HEAD = `你是中国象棋棋手,执红方。`;

const SCOUT_PROMPT = `${RULES_HEAD}

${BOARD}

【侦察任务】只做一件事:列出你此刻最值得考虑的 **3 个候选着法**,每个候选用 1-2 句话说明为什么值得考虑。

- 不要深度推演,不要走完整变例;
- 只需要识别出值得进一步评估的方向;
- 输出 JSON:{"candidates":[{"move":"h3-e3","reason":"..."},{"move":"...","reason":"..."},{"move":"...","reason":"..."}]}
- move 用坐标格式(起点-终点,如 h3-e3)。`;

async function probeOnce(label, extra) {
  const body = {
    model: p.model,
    stream: true,
    max_tokens: 8192, // 阶段①建议上限:看它在这个帽子里能不能装下
    messages: [{ role: 'user', content: SCOUT_PROMPT }],
    ...(p.thinking ?? {}),
    ...extra,
  };
  const t0 = Date.now();
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.api_key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { console.log(`${label} => HTTP ${res.status}`, (await res.text()).slice(0, 200)); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', reasoning = 0, content = '', finish = null, usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const ls = buf.split('\n'); buf = ls.pop() ?? '';
    for (const line of ls) {
      if (!line.startsWith('data:')) continue;
      const pl = line.slice(5).trim();
      if (pl === '[DONE]') continue;
      let d; try { d = JSON.parse(pl); } catch { continue; }
      if (d.choices?.[0]?.finish_reason) finish = d.choices[0].finish_reason;
      if (d.usage) usage = d.usage;
      const delta = d.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content) reasoning += delta.reasoning_content.length;
      if (delta.content) content += delta.content;
    }
  }
  console.log(`[${label}] finish=${finish} | 思考=${reasoning}字符 | 回复=${content.length}字符 | usage=${JSON.stringify(usage ?? {})} | 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  回复前200字: ${content.slice(0, 200).replace(/\n/g, ' ')}`);
}

await probeOnce('侦察·第一次', {});
await probeOnce('侦察·第二次(看稳定性)', {});
