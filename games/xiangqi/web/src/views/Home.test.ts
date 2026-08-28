//
// Home 首页对局列表(T20):列表渲染/分组/状态徽章、开始对局(POST 空配置)、
// 行点击进行中→观战/已结束→回放、空态、刷新。
//
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Home from './Home.vue';
import type { GameListItem } from './Home.vue';

const runner = (id: string, over: Partial<GameListItem> = {}): GameListItem => ({
  id,
  red: { model: 'GLM-5-3-Flash' },
  black: { model: 'deepseek-v4-flash' },
  status: 'running',
  moveCount: 7,
  createdAt: '2026-08-27T10:00:00.000Z',
  updatedAt: '2026-08-27T10:01:00.000Z',
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Home 列表渲染', () => {
  it('进行中(含暂停)与已结束分组展示;徽章/对局人/回合正确', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (!u.startsWith('/api/logs')) throw new Error('unexpected: ' + u);
        return new Response(
          JSON.stringify({
            games: [
              runner('20260827-A-pk-B-01'),
              runner('20260827-A-pk-C-01', { status: 'paused', moveCount: 9 }),
              runner('20260826-D-pk-E-01', {
                status: 'finished',
                moveCount: 40,
                winner: 'red',
                reason: 'checkmate',
              }),
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const w = mount(Home);
    await flushPromises();

    const rows = w.findAll('[data-testid="log-row"]');
    expect(rows).toHaveLength(3);

    const text = w.text();
    expect(text).toContain('进行中');
    expect(text).toContain('已结束');
    expect(text).toContain('GLM-5-3-Flash');
    expect(text).toContain('deepseek-v4-flash');
    expect(text).toContain('回合 4'); // running 7 半回合 → 4 回合
    expect(text).toContain('絕殺'); // checkmate → fmtReason
    expect(text).toContain('胜');

    // 进行中行 → 观战按钮;已结束行 → 回放按钮
    const watchBtn = rows[0].find('[data-testid="watch"]');
    expect(watchBtn.exists()).toBe(true);
    const replayBtn = rows[2].find('[data-testid="replay"]');
    expect(replayBtn.exists()).toBe(true);
    w.unmount();
  });

  it('空列表 → 空态提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ games: [] }), { status: 200 })));
    const w = mount(Home);
    await flushPromises();
    expect(w.find('[data-testid="home-empty"]').exists()).toBe(true);
    w.unmount();
  });

  it('加载失败 → 错误横幅(不崩溃)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    const w = mount(Home);
    await flushPromises();
    expect(w.find('[data-testid="home-error"]').exists()).toBe(true);
    w.unmount();
  });
});

describe('Home 导航行为', () => {
  it('「开始对局」POST 空配置(不再带思考档位)→ toGame 新 id;连续开局两次', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u === '/api/logs') return new Response(JSON.stringify({ games: [] }), { status: 200 });
        if (u === '/api/games') {
          const body = JSON.parse(String(init?.body));
          seen.push(`${body.red.model}|${body.black.model}|${JSON.stringify(body.config)}`);
          return new Response(JSON.stringify({ id: 'g-new' }), { status: 201 });
        }
        throw new Error('unexpected: ' + u);
      }),
    );
    const w = mount(Home);
    await flushPromises();

    // 原则 E(新版):页面无思考模式选择器;仅显示配置说明。红/黑留空 → 服务端回落 config.json。
    expect(w.find('[data-testid="mode-off"]').exists()).toBe(false);
    expect(w.find('[data-testid="thinking-note"]').exists()).toBe(true);
    expect(w.get('[data-testid="start-game"]').text()).toContain('开始对局');

    await w.get('[data-testid="start-game"]').trigger('click');
    await flushPromises();
    expect(w.emitted('toGame')?.[0]).toEqual(['g-new']);
    // 请求体不带 thinkingMode(config 为空对象,档位由服务端 config.models.<name>.thinking 决定)
    expect(seen).toEqual(['||{}']);

    // 再开一局:仍不带思考档位
    await w.get('[data-testid="start-game"]').trigger('click');
    await flushPromises();
    expect(seen).toEqual(['||{}', '||{}']);
    w.unmount();
  });

  it('点击进行中行 → toGame;点击已结束行 → toReplay;按钮同', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            games: [
              runner('20260827-A-pk-B-01'),
              runner('20260826-D-pk-E-01', { status: 'finished', moveCount: 4, winner: 'draw', reason: 'draw-max-moves' }),
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const w = mount(Home);
    await flushPromises();

    const rows = w.findAll('[data-testid="log-row"]');
    await rows[0].trigger('click'); // running → 观战
    expect(w.emitted('toGame')?.[0]).toEqual(['20260827-A-pk-B-01']);
    expect(w.emitted('toReplay')).toBeUndefined();

    await rows[1].trigger('click'); // finished → 回放
    expect(w.emitted('toReplay')?.[0]).toEqual(['20260826-D-pk-E-01']);

    // 行内按钮各自触达
    await rows[0].find('[data-testid="watch"]').trigger('click');
    expect(w.emitted('toGame')?.[1]).toEqual(['20260827-A-pk-B-01']);
    await rows[1].find('[data-testid="replay"]').trigger('click');
    expect(w.emitted('toReplay')?.[1]).toEqual(['20260826-D-pk-E-01']);
    w.unmount();
  });

  it('「刷新」重新拉取列表', async () => {
    let count = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url) !== '/api/logs') throw new Error('unexpected');
        count += 1;
        return new Response(JSON.stringify({ games: [] }), { status: 200 });
      }),
    );
    const w = mount(Home);
    await flushPromises();
    expect(count).toBe(1); // mount 即拉一次

    await w.get('[data-testid="refresh"]').trigger('click');
    await flushPromises();
    expect(count).toBe(2);
    w.unmount();
  });
});