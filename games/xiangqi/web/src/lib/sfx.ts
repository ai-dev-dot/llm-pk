//
// Web Audio 音效(终审 B5 + 动效增强) —— 走子 / 吃子 / 将军 / 终局 四类,🔊/🔇 真 toggle。
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

/** 短促低通噪声爆(敲击质感);无 AudioContext 时安全 no-op。 */
function noiseBurst(c: AudioContext, t: number, dur: number, cutoff: number, vol: number): void {
  const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * vol;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const gain = c.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(c.destination);
  src.start(t);
}

/** 走子:木质敲击 —— 低频三角波下滑(落子主体)+ 短噪声(木质「啪」),更有质感。 */
export function playMove(): void {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(320, t);
  osc.frequency.exponentialRampToValueAtTime(150, t + 0.09);
  gain.gain.setValueAtTime(0.24, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.12);
  noiseBurst(c, t, 0.05, 1200, 0.12);
}

/** 吃子:低闷响(子落盘)+ 更响的敲击噪声(「啪」),比走子更重。 */
export function playCapture(): void {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(70, t + 0.15);
  gain.gain.setValueAtTime(0.34, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.17);
  noiseBurst(c, t, 0.07, 900, 0.3);
}

/** 将军:两声短促方波警示(低→高)。 */
export function playCheck(): void {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const tone = (t0: number, f: number, dur: number, vol: number): void => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.value = f;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur);
  };
  tone(t, 660, 0.12, 0.12);
  tone(t + 0.16, 880, 0.16, 0.12);
}

/** 终局:大三和弦逐音上行(C-E-G),对局收束感。 */
export function playFinish(): void {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const chord = [523.25, 659.25, 783.99];
  chord.forEach((f, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'triangle';
    o.frequency.value = f;
    const t0 = t + i * 0.12;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.16, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + 0.55);
  });
}

/** kind 聚合入口(GameView 事件循环调用)。 */
export function play(kind: 'move' | 'capture' | 'check' | 'finish'): void {
  if (kind === 'capture') playCapture();
  else if (kind === 'check') playCheck();
  else if (kind === 'finish') playFinish();
  else playMove();
}
