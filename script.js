document.addEventListener('DOMContentLoaded', () => {
  // -----------------------------
  // Year
  // -----------------------------
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // -----------------------------
  // Shared Audio Engine (sine + LPF 120Hz)
  // -----------------------------
  let audioContext = null;

  // Generator nodes
  let genOsc = null;
  let genGain = null;
  let genLPF = null;
  let genRunning = false;

  // Test tone nodes (separate so it doesn't fight generator)
  let testOsc = null;
  let testGain = null;
  let testRunning = false;

  function ensureContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
  }

  function softStopNode(ctx, osc, gain, onDone) {
    try {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.06);
      osc.stop(now + 0.07);
      osc.onended = () => onDone?.();
    } catch {
      onDone?.();
    }
  }

  function stopAllAudio() {
    const ctx = audioContext;
    if (!ctx) return;

    if (genRunning && genOsc && genGain) {
      genRunning = false;
      softStopNode(ctx, genOsc, genGain, () => {
        genOsc = null;
        genGain = null;
        genLPF = null;
      });
    }

    if (testRunning && testOsc && testGain) {
      testRunning = false;
      softStopNode(ctx, testOsc, testGain, () => {
        testOsc = null;
        testGain = null;
      });
    }

    document.body.classList.remove('active-audio');
  }

  // -----------------------------
  // Frequency knob (20–120 Hz)
  // -----------------------------
  const MIN_HZ = 20;
  const MAX_HZ = 120;
  let currentHz = 30;

  const knobEl = document.getElementById('freqKnob');
  const readoutEl = document.getElementById('freqReadout');
  const indicatorEl = knobEl ? knobEl.querySelector('.knob-indicator') : null;

  // Map value to knob angle: -135° .. +135°
  function hzToAngle(hz) {
    const t = (hz - MIN_HZ) / (MAX_HZ - MIN_HZ); // 0..1
    return -135 + t * 270;
  }

  function angleToHz(angle) {
    // clamp angle
    const a = Math.max(-135, Math.min(135, angle));
    const t = (a + 135) / 270;
    const hz = MIN_HZ + t * (MAX_HZ - MIN_HZ);
    return Math.round(hz);
  }

  function setHz(hz) {
    currentHz = Math.max(MIN_HZ, Math.min(MAX_HZ, Math.round(hz)));

    if (readoutEl) readoutEl.textContent = String(currentHz);

    if (knobEl) {
      knobEl.setAttribute('aria-valuenow', String(currentHz));
      knobEl.setAttribute('aria-valuetext', `${currentHz} Hz`);
    }

    if (indicatorEl) {
      const angle = hzToAngle(currentHz);
      indicatorEl.style.transform = `translateX(-50%) rotate(${angle}deg)`;
    }

    // If generator is running, update oscillator frequency smoothly
    if (genRunning && audioContext && genOsc) {
      const now = audioContext.currentTime;
      genOsc.frequency.setTargetAtTime(currentHz, now, 0.02);
    }
  }

  // Init UI
  setHz(currentHz);

  // Pointer drag controls
  let dragging = false;

  function getAngleFromPointer(clientX, clientY) {
    const rect = knobEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const dx = clientX - cx;
    const dy = clientY - cy;

    // atan2 gives angle where 0 is +x axis; we want 0 at top.
    let deg = Math.atan2(dy, dx) * (180 / Math.PI);
    deg = deg + 90; // rotate so 0 is at top

    // Normalize to -180..180
    if (deg > 180) deg -= 360;

    return deg;
  }

  function pointerMove(e) {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    const angle = getAngleFromPointer(pt.clientX, pt.clientY);

    // Use only the sweep portion (-135..135). Outside that, clamp.
    const hz = angleToHz(angle);
    setHz(hz);
  }

  function pointerUp() {
    dragging = false;
    window.removeEventListener('mousemove', pointerMove);
    window.removeEventListener('mouseup', pointerUp);
    window.removeEventListener('touchmove', pointerMove, { passive: false });
    window.removeEventListener('touchend', pointerUp);
  }

  if (knobEl) {
    knobEl.addEventListener('mousedown', (e) => {
      dragging = true;
      pointerMove(e);
      window.addEventListener('mousemove', pointerMove);
      window.addEventListener('mouseup', pointerUp);
    });

    knobEl.addEventListener('touchstart', (e) => {
      dragging = true;
      pointerMove(e);
      window.addEventListener('touchmove', pointerMove, { passive: false });
      window.addEventListener('touchend', pointerUp);
    }, { passive: true });

    // Keyboard accessibility: arrows adjust
    knobEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        e.preventDefault();
        setHz(currentHz + 1);
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setHz(currentHz - 1);
      }
      if (e.key === 'PageUp') { e.preventDefault(); setHz(currentHz + 5); }
      if (e.key === 'PageDown') { e.preventDefault(); setHz(currentHz - 5); }
      if (e.key === 'Home') { e.preventDefault(); setHz(MIN_HZ); }
      if (e.key === 'End') { e.preventDefault(); setHz(MAX_HZ); }
    });
  }

  // -----------------------------
  // Generator Start/Stop buttons
  // -----------------------------
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');

  function startGenerator() {
    if (genRunning) return;

    // Stop test tone if running
    if (testRunning) stopAllAudio();

    const ctx = ensureContext();

    genOsc = ctx.createOscillator();
    genGain = ctx.createGain();
    genLPF = ctx.createBiquadFilter();

    genOsc.type = 'sine';
    genOsc.frequency.value = currentHz;

    genLPF.type = 'lowpass';
    genLPF.frequency.value = 120; // always-on LPF at 120Hz
    genLPF.Q.value = 0.707;

    // Start silent then fade in to avoid clicks
    genGain.gain.setValueAtTime(0, ctx.currentTime);

    genOsc.connect(genLPF);
    genLPF.connect(genGain);
    genGain.connect(ctx.destination);

    genOsc.start();

    // soft fade in
    genGain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.08);

    genRunning = true;
    document.body.classList.add('active-audio');
  }

  function stopGenerator() {
    if (!genRunning || !audioContext || !genOsc || !genGain) return;
    genRunning = false;

    softStopNode(audioContext, genOsc, genGain, () => {
      genOsc = null;
      genGain = null;
      genLPF = null;
    });

    document.body.classList.remove('active-audio');
  }

  if (startBtn) startBtn.addEventListener('click', startGenerator);
  if (stopBtn) stopBtn.addEventListener('click', stopGenerator);

  // -----------------------------
  // Test tone (3030Hz for 9s)
  // -----------------------------
  const testBtn = document.getElementById('testToneBtn');

  function playTestTone() {
    if (testRunning) return;

    // Stop generator if running
    if (genRunning) stopGenerator();

    const ctx = ensureContext();

    testOsc = ctx.createOscillator();
    testGain = ctx.createGain();

    testOsc.type = 'sine';
    testOsc.frequency.value = 3030;

    testGain.gain.setValueAtTime(0, ctx.currentTime);

    testOsc.connect(testGain);
    testGain.connect(ctx.destination);

    testOsc.start();

    testGain.gain.linearRampToValueAtTime(0.20, ctx.currentTime + 0.08);
    testGain.gain.setValueAtTime(0.20, ctx.currentTime + 8.8);
    testGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 9);

    testOsc.stop(ctx.currentTime + 9);

    testRunning = true;
    document.body.classList.add('active-audio');

    testOsc.onended = () => {
      testRunning = false;
      testOsc = null;
      testGain = null;
      document.body.classList.remove('active-audio');
    };
  }

  if (testBtn) testBtn.addEventListener('click', playTestTone);

  // -----------------------------
  // WARNING buttons = panic stop (stops generator + test tone)
  // -----------------------------
  document.querySelectorAll('.warn-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.add('warn-pressed');
      stopAllAudio();
      setTimeout(() => btn.classList.remove('warn-pressed'), 120);
    });
  });
});
