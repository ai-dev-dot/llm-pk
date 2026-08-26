//
// 极简 Web Audio 音效(Task 终审 B5) —— 走子 / 吃子各一种,🔊/🔇 开关可真 toggle。
// 自动播放策略:AudioContext 惰性创建,首次在首帧调用 `unlock()`(用户手势)后 resume;
// 未解锁/无 AudioContext(如 jsdom)时全部安全 no-op。
//
let ctx: AudioContext | null = null;
let muted = false;

type AudioCtor = typeof AudioContext;

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/** 用户手势解锁(浏览器自动播放策略):挂 header 点击 / mute 按钮即起。幂等。 */
export function unlock(): void {
  const c = ac();
  if (c && c.state === 'suspended') void c.resume().catch(() => {});
}

export function setMuted(m: boolean): void {
  muted = m;
}

export function isMuted(): boolean {
  return muted;
}

/** 走子:短促三角波单音(木质敲击感)。 */
export function playMove(): void {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(420, t);
  gain.gain.setValueAtTime(0.16, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.08);
}

/** 吃子:低通噪声短爆(子落盘闷响)。 */
export function playCapture(): void {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const dur = 0.1;
  const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 800;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.28, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(c.destination);
  src.start(t);
}

/** kind 聚合入口(GameView 事件循环调用)。 */
export function play(kind: 'move' | 'capture'): void {
  if (kind === 'capture') playCapture();
  else playMove();
}