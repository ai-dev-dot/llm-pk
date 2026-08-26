//
// sfx 模块测试(B5):jsdom 下无 AudioContext,所有调用必须安全 no-op 不抛;
// 🔊/🔇 开关经 setMuted/isMuted 真 toggle。
//
import { describe, expect, it } from 'vitest';
import { isMuted, play, playCapture, playMove, setMuted, unlock } from './sfx';

describe('sfx 音效模块', () => {
  it('jsdom(无 AudioContext)下 unlock/play 全为安全 no-op,不抛错', () => {
    expect(() => {
      unlock();
      play('move');
      play('capture');
      playMove();
      playCapture();
    }).not.toThrow();
  });

  it('setMuted/isMuted 真 toggle;静音后 play 仍安全 no-op', () => {
    setMuted(true);
    expect(isMuted()).toBe(true);
    expect(() => play('move')).not.toThrow();
    setMuted(false);
    expect(isMuted()).toBe(false);
  });
});