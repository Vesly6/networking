// A short, generated two-tone "ding" rather than a bundled audio file —
// no asset to license/ship, and it's the exact same Web Audio API this
// codebase already has no dependency-free reason to avoid. Used only for
// the "it's time to call" reminder (useReminderStore.ts) — deliberately
// short and non-intrusive, not a ringtone.
let sharedContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedContext) sharedContext = new Ctor();
  return sharedContext;
}

export function playReminderSound(): void {
  const ctx = getContext();
  if (!ctx) return;
  // Browsers suspend a freshly-created (or long-idle) AudioContext until a
  // user gesture resumes it — this fires from a background poll timer, not
  // a click, so it may still be suspended; resume() is a safe no-op if it
  // already isn't.
  void ctx.resume();

  const now = ctx.currentTime;
  const playTone = (freq: number, start: number, duration: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Quick fade in/out instead of a hard on/off edge, which would
    // otherwise produce an audible click at the start/end of each tone.
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(0.2, now + start + 0.02);
    gain.gain.linearRampToValueAtTime(0, now + start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + duration + 0.02);
  };
  playTone(880, 0, 0.15);
  playTone(1320, 0.17, 0.2);
}
