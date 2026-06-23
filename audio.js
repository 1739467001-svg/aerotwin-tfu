/* ============================================================
   AEROTWIN web · 生成式环境背景音乐（audio.js）
   纯 Web Audio API 程序化合成，无外部音频文件、零依赖、零版权。
   舒缓的铺底和弦（缓入缓出）+ 偶发清脆点音 + 程序化卷积混响，
   适配宁静的机场数字孪生氛围。默认不自动播放，由 UI 开关在用户手势中启动。
   ============================================================ */
(function (global) {
  "use strict";
  function create() {
    let ctx = null, master = null, reverb = null, wet = null, running = false, timer = null;
    let chordIdx = 0, nextTime = 0, twinkleAt = 0;

    // 四和弦缓行进（C 大调 / a 小调色彩，开阔平和）；频率单位 Hz
    const CHORDS = [
      [261.63, 329.63, 392.00, 493.88],   // Cmaj9 (C E G B)
      [220.00, 261.63, 329.63, 392.00],   // Am9   (A C E G)
      [174.61, 220.00, 261.63, 329.63],   // Fmaj7 (F A C E)
      [196.00, 246.94, 293.66, 392.00],   // G     (G B D G)
    ];
    const CHORD_DUR = 7.5;   // 每个和弦时值（秒）

    function makeReverb() {                // 程序化脉冲响应：指数衰减噪声 → 空间感
      const len = Math.floor(ctx.sampleRate * 2.6), buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
      const c = ctx.createConvolver(); c.buffer = buf; return c;
    }
    // 铺底和弦音：双振荡微失谐 + 低通 + 缓入缓出包络
    function voice(freq, t0, dur, peak, type) {
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o1.type = type || "sine"; o2.type = "triangle";
      o1.frequency.value = freq; o2.frequency.value = freq; o2.detune.value = 6;
      f.type = "lowpass"; f.frequency.value = 1500; f.Q.value = 0.4;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 2.0);     // 缓入
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);   // 缓出
      o1.connect(g); o2.connect(g); g.connect(f); f.connect(master); f.connect(reverb);
      o1.start(t0); o2.start(t0); o1.stop(t0 + dur + 0.1); o2.stop(t0 + dur + 0.1);
    }
    // 偶发清脆点音（高八度，快速衰减）
    function bell(freq, t0) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.11, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.6);
      o.connect(g); g.connect(master); g.connect(reverb);
      o.start(t0); o.stop(t0 + 2.7);
    }
    function schedule() {                  // 前瞻调度：提前 0.4s 排好下一个和弦
      const now = ctx.currentTime;
      while (nextTime < now + 0.4) {
        const ch = CHORDS[chordIdx % CHORDS.length];
        for (const fr of ch) voice(fr, nextTime, CHORD_DUR + 1.6, 0.095);
        voice(ch[0] / 2, nextTime, CHORD_DUR + 1.6, 0.12, "sine");   // 低音根音
        chordIdx++; nextTime += CHORD_DUR;
      }
      if (now > twinkleAt) {
        const ch = CHORDS[(chordIdx - 1 + CHORDS.length) % CHORDS.length];
        bell(ch[Math.floor(Math.random() * ch.length)] * 2, now + 0.05);
        twinkleAt = now + 3.5 + Math.random() * 5;
      }
    }
    function start() {
      if (!ctx) {
        ctx = new (global.AudioContext || global.webkitAudioContext)();
        master = ctx.createGain(); master.gain.value = 0.0001; master.connect(ctx.destination);
        reverb = makeReverb(); wet = ctx.createGain(); wet.gain.value = 0.5; reverb.connect(wet); wet.connect(master);
        nextTime = ctx.currentTime + 0.15; twinkleAt = ctx.currentTime + 2;
      }
      ctx.resume();
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.17, ctx.currentTime + 2.5);   // 渐入
      running = true;
      if (!timer) timer = setInterval(schedule, 250);
    }
    function stop() {
      if (!ctx) return;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.2);  // 渐出
      running = false;
      setTimeout(() => { if (!running && timer) { clearInterval(timer); timer = null; } }, 1400);
    }
    return {
      toggle() { if (running) stop(); else start(); return running; },
      isOn() { return running; },
    };
  }
  global.AeroAudio = { create };
})(typeof window !== "undefined" ? window : globalThis);
