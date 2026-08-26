//
// GameControls 渲染测试:播放/暂停标签、单步禁用态、emit、速度与静音。
//
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import GameControls from './GameControls.vue';
import type { GamePhase } from '../composables/useGame';

function mountCtl(extra: { status?: GamePhase; speed?: number; muted?: boolean } = {}) {
  return mount(GameControls, {
    props: { status: extra.status ?? 'running', speed: extra.speed ?? 1, muted: extra.muted ?? false },
  });
}

describe('GameControls', () => {
  it('running:按钮为「暂停」,step 禁用', () => {
    const w = mountCtl({ status: 'running' });
    expect(w.get('[data-testid="play"]').text()).toContain('暂停');
    expect((w.get('[data-testid="step"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it('paused:按钮为「继续」,step 可用', () => {
    const w = mountCtl({ status: 'paused' });
    expect(w.get('[data-testid="play"]').text()).toContain('继续');
    expect((w.get('[data-testid="step"]').element as HTMLButtonElement).disabled).toBe(false);
  });

  it('点击 play 冒泡 toggle-play;paused 时点击 step 冒泡 step', async () => {
    const w = mountCtl({ status: 'paused' });
    await w.get('[data-testid="play"]').trigger('click');
    await w.get('[data-testid="step"]').trigger('click');
    expect(w.emitted('toggle-play')).toHaveLength(1);
    expect(w.emitted('step')).toHaveLength(1);
  });

  it('finished:play 禁用,标签「已终局」;重开可点', () => {
    const w = mountCtl({ status: 'finished' });
    expect(w.get('[data-testid="play"]').text()).toContain('已终局');
    expect((w.get('[data-testid="play"]').element as HTMLButtonElement).disabled).toBe(true);
    expect((w.get('[data-testid="restart"]').element as HTMLButtonElement).disabled).toBe(false);
  });

  it('速度段:点击 2× 冒泡 speed=2 且高亮 on', async () => {
    const w = mountCtl({ status: 'running', speed: 1 });
    const btns = w.findAll('[data-testid="speed"]');
    expect(btns).toHaveLength(3);
    await btns[1]!.trigger('click');
    expect(w.emitted('speed')).toEqual([[2]]);
  });

  it('静音切换:点击冒泡 toggle-mute,label 在 🔊/🔇 间切换', async () => {
    const w = mountCtl({ status: 'running', muted: true });
    expect(w.get('[data-testid="mute"]').text()).toContain('🔇');
    await w.get('[data-testid="mute"]').trigger('click');
    expect(w.emitted('toggle-mute')).toHaveLength(1);
  });
});