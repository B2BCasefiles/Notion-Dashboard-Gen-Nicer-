/*
 * Nicer Cinematic Product Story Animations (ES6)
 *
 * Public API (available on window.NicerCinematic):
 * - play(): Start or restart demo from beginning. No autoplay by default.
 * - pause(): Pause demo and ambient visuals.
 * - reset(): Stop, rewind to t=0, clear ambient visuals.
 * - setTimeScale(scale: number): Adjust playback speed; auto-applies reduced motion defaults.
 * - isActive(): Returns boolean if master timeline is currently playing.
 * - destroy(): Fully tear down timelines, listeners, and 3D/canvas contexts.
 * - rebuild(): Re-initialize the system after destroy (for hot reload / dynamic content).
 * - version: string
 *
 * TODO (intentional extension points for future teams):
 * - Audio engine hooks (sound design cues on scene transitions)
 * - Drag-and-drop widgets in customize scene
 * - Voice cue activation / microphone-driven pacing
 * - Dashboard morphing templates (types → live Notion-like previews)
 * - Advanced analytics hooks for scene onStart/onComplete
 */

/* eslint-disable */
(() => {
  'use strict';

  /**
   * Global configuration (designer-friendly). Keep values modest for perf.
   * Designers can tweak these without touching JS logic elsewhere.
   */
  const CONFIG = {
    debug: false,
    reducedMotionScale: 0.4,
    maxDevicePixelRatio: 2,
    particles: {
      defaultCount: 28,
      burstCount: 36,
      minCount: 12, // used in reduced motion
      gravity: 0.05,
      maxFrames: 120
    },
    three: {
      fov: 28,
      ambientIntensity: 0.25,
      pointLightIntensity: 1.2,
      pointLightDistance: 50,
      cardOpacity: 0.35,
      cardRoughness: 0.6,
      cardMetalness: 0.2,
      cards: 7
    },
    parallax: {
      pointerSensitivityX: 12,
      pointerSensitivityY: 8,
      cameraSensitivityX: 1.2,
      cameraSensitivityY: 1.0,
      tiltSensitivity: 0.6 // mobile tilt multiplier
    },
    shimmer: {
      buttonShadow: '0 0 24px rgba(16,185,129,0.45)'
    },
    mobile: {
      particleScale: 0.6,
      threeCards: 4,
      ambientMinDelay: 3,
      ambientMaxDelay: 5,
      shimmerEnabled: false,
      parallaxMultiplier: 0.7
    }
  };

  /** Feature detection */
  const hasGSAP = typeof window.gsap !== 'undefined';
  const hasScrollTrigger = typeof window.ScrollTrigger !== 'undefined';
  const hasScrollToPlugin = typeof window.ScrollToPlugin !== 'undefined';
  const hasTextPlugin = typeof window.TextPlugin !== 'undefined';
  const hasTHREE = typeof window.THREE !== 'undefined';
  const hasAnime = typeof window.anime !== 'undefined';

  // Small-screen helper
  const mqSmall = window.matchMedia && window.matchMedia('(max-width: 640px)');
  function isSmallScreen() {
    return mqSmall ? mqSmall.matches : (window.innerWidth || 0) <= 640;
  }

  // Fail-fast guard: if GSAP is not available, exit gracefully.
  if (!hasGSAP) {
    console.warn('[NicerCinematic] GSAP not found. Cinematic demo disabled.');
    // Ensure hero scene (SVG group) is visible so UI never feels broken
    requestAnimationFrame(() => {
      const gHero = document.getElementById('scene-hero');
      if (gHero) gHero.style.opacity = '1';
    });
    return;
  }

  // Register GSAP plugins (conditionally).
  try {
    if (hasScrollTrigger) gsap.registerPlugin(ScrollTrigger);
    if (hasScrollToPlugin) gsap.registerPlugin(ScrollToPlugin);
    if (hasTextPlugin) gsap.registerPlugin(TextPlugin);
  } catch (e) {
    console.warn('[NicerCinematic] Failed to register GSAP plugins', e);
  }

  /**
   * Internal state container. All mutable runtime references live here for easy teardown.
   */
  const state = {
    initialized: false,
    prefersReducedMotion: false,
    stage: null,
    svg: null,
    fxCanvas: /** @type {HTMLCanvasElement|null} */ (null),
    threeRoot: null,
    // three.js objects
    renderer: null,
    scene: null,
    camera: null,
    threeCards: /** @type {Array<any>} */ ([]),
    threeRafId: 0,
    // timelines
    masterTL: null,
    ambientTL: null,
    ambientBurstDC: null,
    // listeners to cleanup
    listeners: [],
    // additional cleanups (functions)
    cleanups: [],
    // performance monitor
    perf: { lastTime: 0, jankThresholdMs: 42, warnCount: 0 },
    // parallax
    pointerHandler: null,
    tiltHandler: null,
    hasTiltPermission: false,
    // scene refs
    elements: {},
    // Three.js loop controls
    startThree: null,
    stopThree: null,
    // visibility control state
    wasPlaying: false,
    // lock logo center during hero scene
    lockLogoCenter: true,
    // track logo float tween
    logoFloatTween: null
  };

  /**
   * Utility: add event listener and track for cleanup.
   * @param {Element|Window|Document} target
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} handler
   * @param {AddEventListenerOptions|boolean} [opts]
   */
  function on(target, type, handler, opts) {
    if (!target || !target.addEventListener) return;
    target.addEventListener(type, handler, opts);
    state.listeners.push({ target, type, handler, opts });
  }

  /** Track a custom cleanup function (for observers, timers, etc.). */
  function trackCleanup(fn) {
    if (typeof fn === 'function') state.cleanups.push(fn);
  }

  /** Remove and clear all tracked listeners. */
  function removeAllListeners() {
    state.listeners.forEach(({ target, type, handler, opts }) => {
      try { target.removeEventListener(type, handler, opts); } catch (_) {}
    });
    state.listeners = [];
    state.cleanups.forEach(fn => { try { fn(); } catch (_) {} });
    state.cleanups = [];
  }

  /**
   * Accessibility: ensure stage, svg, and canvas are keyboard-friendly and properly labeled.
   */
  function applyAccessibilityAttributes() {
    const stage = document.getElementById('cinematic-stage');
    if (stage) {
      stage.setAttribute('role', 'region');
      stage.setAttribute('aria-label', 'Nicer cinematic animated demo stage');
      stage.setAttribute('tabindex', '0');
    }
    const svg = document.getElementById('story-svg');
    if (svg) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Animated product story visuals');
      // Keep non-focusable for keyboard nav
      svg.setAttribute('focusable', 'false');
    }
    const fxCanvas = document.getElementById('fx-canvas');
    if (fxCanvas) {
      fxCanvas.setAttribute('role', 'img');
      fxCanvas.setAttribute('aria-label', 'Particle effects canvas');
      fxCanvas.setAttribute('tabindex', '-1');
    }
    const threeRoot = document.getElementById('three-root');
    if (threeRoot) {
      threeRoot.setAttribute('aria-hidden', 'true');
      threeRoot.setAttribute('tabindex', '-1');
    }
  }

  /**
   * Performance instrumentation: log jank if frames exceed threshold.
   */
  function startPerfMonitor() {
    if (!CONFIG.debug) return;
    const tick = (time) => {
      if (state.perf.lastTime) {
        const delta = time - state.perf.lastTime;
        if (delta > state.perf.jankThresholdMs) {
          state.perf.warnCount += 1;
          console.warn(`[NicerCinematic] Frame jank detected: ${Math.round(delta)}ms`);
        }
      }
      state.perf.lastTime = time;
      state.perf.rafId = requestAnimationFrame(tick);
    };
    state.perf.rafId = requestAnimationFrame(tick);
  }

  function stopPerfMonitor() {
    if (state.perf.rafId) cancelAnimationFrame(state.perf.rafId);
    state.perf.rafId = 0;
    state.perf.lastTime = 0;
  }

  /**
   * Immediately reveal hero group at minimal viable opacity so UI feels responsive.
   */
  function ensureImmediateVisibility() {
    requestAnimationFrame(() => {
      const gHero = document.getElementById('scene-hero');
      if (gHero) gHero.style.opacity = '1';
    });
  }

  /**
   * Particle burst via Canvas
   * @param {{ x:number, y:number, color?:string, count?:number }} opts
   */
  function particlesBurst(opts) {
    const { x, y } = opts;
    const color = opts.color || '#10B981';
    const baseCount = opts.count || CONFIG.particles.defaultCount;
    if (!state.fxCanvas || state.prefersReducedMotion) return;

    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDevicePixelRatio);
    const scale = isSmallScreen() ? CONFIG.mobile.particleScale : 1;
    const count = Math.max(1, Math.round(baseCount * scale * (dpr > 1.5 ? 0.9 : 1)));

    const ctx = state.fxCanvas.getContext('2d');
    const particles = new Array(Math.max(1, count)).fill(0).map(() => ({
      x, y,
      vx: (Math.random() - 0.5) * 6,
      vy: (Math.random() - 0.5) * 6,
      life: 60 + Math.random() * 40,
      r: 2 + Math.random() * 2,
      c: color,
    }));
    let frame = 0;

    const draw = () => {
      frame += 1;
      ctx.clearRect(0, 0, state.fxCanvas.width, state.fxCanvas.height);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.vy += CONFIG.particles.gravity; p.life -= 1;
        ctx.globalAlpha = Math.max(0, p.life / 100);
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      });
      if (frame < CONFIG.particles.maxFrames) {
        requestAnimationFrame(draw);
      } else {
        ctx.clearRect(0, 0, state.fxCanvas.width, state.fxCanvas.height);
      }
    };

    const rect = state.stage.getBoundingClientRect();
    state.fxCanvas.width = rect.width;
    state.fxCanvas.height = rect.height;
    draw();
  }

  /**
   * Initialize Three.js background scene (floating cards) with gentle sway.
   */
  function initThree() {
    if (!hasTHREE) return; // graceful if not present
    if (!state.threeRoot || state.prefersReducedMotion) return; // reduce intensity

    const width = state.stage.clientWidth;
    const height = state.stage.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDevicePixelRatio);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height);
    state.threeRoot.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(CONFIG.three.fov, width / height, 0.1, 100);
    camera.position.set(0, 0, 10);

    const light = new THREE.PointLight(0x10b981, CONFIG.three.pointLightIntensity, CONFIG.three.pointLightDistance);
    light.position.set(2, 3, 6);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0xffffff, CONFIG.three.ambientIntensity));

    const geom = new THREE.PlaneGeometry(1.4, 0.9, 1, 1);
    const mats = [0x16353a, 0x102a2d, 0x0a1f22].map(c => new THREE.MeshStandardMaterial({
      color: c,
      transparent: true,
      opacity: CONFIG.three.cardOpacity,
      roughness: CONFIG.three.cardRoughness,
      metalness: CONFIG.three.cardMetalness
    }));

    const cards = [];
    const totalCards = isSmallScreen() ? Math.min(CONFIG.three.cards, CONFIG.mobile.threeCards) : CONFIG.three.cards;
    for (let i = 0; i < totalCards; i++) {
      const mesh = new THREE.Mesh(geom, mats[i % mats.length]);
      mesh.position.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 3);
      mesh.rotation.set(0, Math.random() * 0.6, 0);
      scene.add(mesh);
      cards.push(mesh);
    }

    const render = () => {
      state.threeRafId = requestAnimationFrame(render);
      const now = performance.now();
      cards.forEach((m, idx) => {
        m.position.y += Math.sin(now / 1000 + idx) * 0.0005;
        m.rotation.z += 0.0004;
      });
      renderer.render(scene, camera);
    };

    const onResize = () => {
      if (!renderer) return;
      const w = state.threeRoot.clientWidth;
      const h = state.threeRoot.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    on(window, 'resize', onResize, { passive: true });

    // Do not start loop yet (mobile optimization) — render a single frame
    renderer.render(scene, camera);

    // store and expose loop controls
    state.renderer = renderer;
    state.scene = scene;
    state.camera = camera;
    state.threeCards = cards;
    state.startThree = () => { if (!state.threeRafId) render(); };
    state.stopThree = () => { if (state.threeRafId) { cancelAnimationFrame(state.threeRafId); state.threeRafId = 0; } };
  }

  /** Kill/cleanup Three.js resources */
  function destroyThree() {
    if (state.threeRafId) cancelAnimationFrame(state.threeRafId);
    state.threeRafId = 0;
    if (state.renderer) {
      try { state.renderer.dispose(); } catch (_) {}
      if (state.renderer.domElement && state.renderer.domElement.parentNode) {
        state.renderer.domElement.parentNode.removeChild(state.renderer.domElement);
      }
    }
    state.renderer = null;
    state.scene = null;
    state.camera = null;
    state.threeCards = [];
    state.startThree = null;
    state.stopThree = null;
  }

  /**
   * Magnetic hover & shimmer for buttons.
   */
  function initButtonInteractions() {
    // Avoid duplicating existing hover logic from inline scripts; scope to Launch Demo only
    const btn = document.getElementById('launch-demo');
    if (!btn) return;

    if (!isSmallScreen() && CONFIG.mobile.shimmerEnabled === false) {
      // On desktop we still allow shimmer
      gsap.to(btn, { boxShadow: CONFIG.shimmer.buttonShadow, duration: 1.6, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    }

    const mouseMove = (e) => {
      const r = btn.getBoundingClientRect();
      const x = e.clientX - r.left - r.width / 2;
      const y = e.clientY - r.top - r.height / 2;
      gsap.to(btn, { x: x * 0.08, y: y * 0.1, duration: 0.25, ease: 'power2.out' });
    };
    const mouseLeave = () => gsap.to(btn, { x: 0, y: 0, duration: 0.35, ease: 'power2.out' });
    on(btn, 'mousemove', mouseMove, { passive: true });
    on(btn, 'mouseleave', mouseLeave, { passive: true });
  }

  /**
   * Pointer parallax (desktop) and tilt parallax (mobile/device orientation)
   */
  function initParallax() {
    // Pointer parallax with rAF throttle
    let pointerRAF = 0;
    let nxPending = 0, nyPending = 0;
    state.pointerHandler = (e) => {
      if (state.lockLogoCenter) return; // keep logo centered during hero
      const rect = state.stage.getBoundingClientRect();
      nxPending = (e.clientX - rect.left) / rect.width - 0.5;
      nyPending = (e.clientY - rect.top) / rect.height - 0.5;
      if (!pointerRAF) {
        pointerRAF = requestAnimationFrame(() => {
          pointerRAF = 0;
          const mult = isSmallScreen() ? CONFIG.mobile.parallaxMultiplier : 1;
          gsap.to('#notion-logo', { x: nxPending * CONFIG.parallax.pointerSensitivityX * mult, y: nyPending * CONFIG.parallax.pointerSensitivityY * mult, duration: 0.4, ease: 'power2.out' });
          if (state.camera) {
            state.camera.position.x = nxPending * CONFIG.parallax.cameraSensitivityX * mult;
            state.camera.position.y = -nyPending * CONFIG.parallax.cameraSensitivityY * mult;
          }
        });
      }
    };
    on(state.stage, 'pointermove', state.pointerHandler, { passive: true });

    // Tilt parallax (opt-in on iOS due to permission) with throttle
    const requestTiltPermissionIfNeeded = () => {
      const DeviceOrientationEvent = window.DeviceOrientationEvent;
      if (!DeviceOrientationEvent) return;
      const hasRequest = typeof DeviceOrientationEvent.requestPermission === 'function';
      if (hasRequest && !state.hasTiltPermission) {
        DeviceOrientationEvent.requestPermission().then(result => {
          if (result === 'granted') {
            state.hasTiltPermission = true; wireTilt();
          }
        }).catch(() => {});
      } else {
        wireTilt();
      }
    };
    const launchBtn = document.getElementById('launch-demo');
    if (launchBtn) on(launchBtn, 'click', requestTiltPermissionIfNeeded, { once: true, passive: true });

    function wireTilt() {
      if (state.tiltHandler) return;
      let tiltRAF = 0, nx = 0, ny = 0;
      state.tiltHandler = (ev) => {
        if (state.lockLogoCenter) return; // keep logo centered during hero
        if (ev.beta == null || ev.gamma == null) return;
        nx = (ev.gamma || 0) / 45; // -45 to 45 approx
        ny = (ev.beta || 0) / 45;  // -45 to 45 approx
        if (!tiltRAF) {
          tiltRAF = requestAnimationFrame(() => {
            tiltRAF = 0;
            const mult = isSmallScreen() ? CONFIG.mobile.parallaxMultiplier : 1;
            gsap.to('#notion-logo', { x: nx * CONFIG.parallax.pointerSensitivityX * CONFIG.parallax.tiltSensitivity * mult, y: ny * CONFIG.parallax.pointerSensitivityY * CONFIG.parallax.tiltSensitivity * mult, duration: 0.4 });
          });
        }
      };
      on(window, 'deviceorientation', state.tiltHandler);
    }
  }

  /**
   * Scene factories — each returns a GSAP timeline and accepts config & lifecycle hooks.
   * All DOM refs are null-checked to avoid runtime errors.
   */
  function heroScene({ onStart, onComplete } = {}) {
    const gHero = document.getElementById('scene-hero');
    const tl = gsap.timeline({ onStart, onComplete });
    if (!gHero) return tl;
    // Ensure logo starts perfectly centered and lock parallax influence
    tl.add(() => {
      state.lockLogoCenter = true;
      try { gsap.killTweensOf('#notion-logo'); } catch (_) {}
      gsap.set('#notion-logo', { x: 0, y: 0 });
    }, 0);
    tl.set(['#scene-describe', '#scene-ai', '#scene-customize', '#scene-nocode', '#scene-notion', '#scene-security', '#scene-types', '#scene-signup'], { opacity: 0 })
      .fromTo(gHero, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.9, ease: 'power2.out' })
      .from('#notion-logo', { y: -8, opacity: 0, duration: 0.6 }, '-=0.4')
      .to('#notion-logo', { filter: 'url(#soft-glow)', duration: 0.2 }, '+=0.1')
      .to('#notion-logo', { scale: 1.25, duration: 0.35, transformOrigin: '50% 50%', ease: 'power2.out' })
      .to('#notion-logo', { scale: 0.8, opacity: 0.2, duration: 0.35, ease: 'power2.in' })
      .to('#notion-logo', { opacity: 0, duration: 0.2 })
      // Unlock after hero completes; resume ambient float if active
      .add(() => {
        state.lockLogoCenter = false;
        if (state.ambientTL && !state.logoFloatTween && document.getElementById('notion-logo')) {
          state.logoFloatTween = gsap.to('#notion-logo', { y: '+=6', duration: 2.2, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        }
      });
    return tl;
  }

  function describeScene({ onStart, onComplete } = {}) {
    const gHero = document.getElementById('scene-hero');
    const gDescribe = document.getElementById('scene-describe');
    const overlay = document.getElementById('epic-headline');
    const hl1 = document.getElementById('hl-1');
    const hl2 = document.getElementById('hl-2');
    const hl3 = document.getElementById('hl-3');
    const describeText = document.getElementById('describe-text');

    const tl = gsap.timeline({ onStart, onComplete });
    if (!gDescribe) return tl;

    tl.add(() => { if (gHero) gsap.to(gHero, { opacity: 0, duration: 0.4 }); });
    if (overlay && hl1 && hl2 && hl3) {
      if (hasTextPlugin) {
        tl.set([hl1, hl2, hl3], { text: '' })
          .set(overlay, { opacity: 0 })
          .to(overlay, { opacity: 1, duration: 0.4 })
          .to(hl1, { text: 'AI for Notion Dashboards.', duration: 0.8, ease: 'none' }, '<')
          .to(hl2, { text: 'Instantly. Beautifully.', duration: 0.8, ease: 'none' }, '+=0.1')
          .to(hl3, { text: 'Smartly.', duration: 0.6, ease: 'none' }, '+=0.05')
          .to(overlay, { opacity: 0, duration: 0.5, delay: 0.2 });
      } else {
        // Fallback if TextPlugin is unavailable
        tl.set(overlay, { opacity: 1 })
          .add(() => { hl1.textContent = 'AI for Notion Dashboards.'; })
          .to({}, { duration: 0.8 })
          .add(() => { hl2.textContent = 'Instantly. Beautifully.'; })
          .to({}, { duration: 0.8 })
          .add(() => { hl3.textContent = 'Smartly.'; })
          .to({}, { duration: 0.6 })
          .to(overlay, { opacity: 0, duration: 0.5 });
      }
    }

    tl.to(gDescribe, { opacity: 1, duration: 0.6, ease: 'power1.out' });

    if (describeText) {
      // Simulated typing with caret
      const caretId = 'describe-caret';
      let caret = document.getElementById(caretId);
      if (!caret) {
        caret = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        caret.setAttribute('id', caretId);
        caret.setAttribute('x', String(Number(describeText.getAttribute('x')) + 2 || 292));
        caret.setAttribute('y', '322');
        caret.setAttribute('width', '2');
        caret.setAttribute('height', '24');
        caret.setAttribute('fill', '#d1fae5');
        gDescribe.appendChild(caret);
      }
      const fullText = "Team Project Tracker, with progress charts, to-do lists, deadlines";
      if (hasTextPlugin) {
        tl.set(describeText, { text: '' })
          .to(describeText, { text: fullText, duration: 1.8, ease: 'none' }, '<')
          .to(caret, { opacity: 0, duration: 0.4, repeat: 4, yoyo: true }, '<');
      } else {
        // Minimal fallback typing without plugin
        tl.add(() => {
          describeText.textContent = '';
          let i = 0;
          const step = Math.max(1, Math.floor(fullText.length / 28));
          const typer = () => {
            i = Math.min(fullText.length, i + step);
            describeText.textContent = fullText.slice(0, i);
            if (i < fullText.length) requestAnimationFrame(typer);
          };
          typer();
        }, '<');
        tl.to(caret, { opacity: 0, duration: 0.4, repeat: 4, yoyo: true }, '<');
      }
    }

    return tl;
  }

  function aiScene({ onStart, onComplete } = {}) {
    const gAI = document.getElementById('scene-ai');
    const tl = gsap.timeline({ onStart, onComplete });
    if (!gAI) return tl;

    tl.to(['#scene-describe'], { opacity: 0, duration: 0.3 })
      .to(gAI, { opacity: 1, duration: 0.6, ease: 'power1.out' })
      .add(() => {
        // Stroke reveal without external plugins
        const paths = state.svg ? state.svg.querySelectorAll('#ai-circuits path') : [];
        paths.forEach((p, i) => {
          const len = p.getTotalLength();
          p.style.strokeDasharray = String(len);
          p.style.strokeDashoffset = String(len);
          gsap.to(p, { strokeDashoffset: 0, duration: 1.0, ease: 'power1.inOut', delay: i * 0.08 });
        });
      })
      .to('#scene-ai circle', { scale: 1.05, transformOrigin: '50% 50%', yoyo: true, repeat: 3, duration: 0.35 }, '<')
      .add(() => {
        const rect = state.stage.getBoundingClientRect();
        particlesBurst({ x: rect.width / 2, y: rect.height / 2, color: '#10B981', count: state.prefersReducedMotion ? CONFIG.particles.minCount : 40 });
      }, '-=0.3');

    return tl;
  }

  function customizeScene({ onStart, onComplete } = {}) {
    const gCustomize = document.getElementById('scene-customize');
    const sliderKnob = document.getElementById('slider-knob');
    const tl = gsap.timeline({ onStart, onComplete });
    if (!gCustomize) return tl;

    tl.to('#scene-ai', { opacity: 0, duration: 0.3 })
      .to(gCustomize, { opacity: 1, duration: 0.6 })
      .from(['#custom-card-1', '#custom-card-2', '#custom-card-3'], { y: 14, opacity: 0, duration: 0.6, stagger: 0.1, ease: 'power2.out' })
      .to('#custom-card-1, #custom-card-2, #custom-card-3', { fill: 'rgba(16,185,129,0.18)', duration: 0.8, stagger: 0.1 }, '<')
      .to('#palette', { attr: { width: 160 }, duration: 0.6 }, '<');
    if (sliderKnob) tl.to(sliderKnob, { attr: { cx: 440 }, duration: 0.8, ease: 'power1.inOut' }, '<');
    return tl;
  }

  function noCodeScene({ onStart, onComplete } = {}) {
    const gNoCode = document.getElementById('scene-nocode');
    const tl = gsap.timeline({ onStart, onComplete });
    if (!gNoCode) return tl;

    tl.to('#scene-customize', { opacity: 0, duration: 0.3 })
      .to(gNoCode, { opacity: 1, duration: 0.4 })
      .from(gNoCode, { rotation: -1, transformOrigin: '50% 50%', duration: 0.4 })
      .to(gNoCode, { x: 280, rotation: -18, duration: 0.6, ease: 'power2.in' })
      .add(() => {
        const rect = state.stage.getBoundingClientRect();
        particlesBurst({ x: rect.width - 120, y: rect.height / 2 - 40, color: '#22d3ee', count: state.prefersReducedMotion ? CONFIG.particles.minCount : 24 });
      });
    return tl;
  }

  function notionScene({ onStart, onComplete } = {}) {
    const gNotion = document.getElementById('scene-notion');
    const tl = gsap.timeline({ onStart, onComplete });
    if (!gNotion) return tl;

    tl.to('#scene-nocode', { opacity: 0, duration: 0.3 })
      .to(gNotion, { opacity: 1, duration: 0.5 })
      .from('#import-panel', { x: -40, opacity: 0, duration: 0.6 })
      .to('#import-panel', { x: 260, duration: 0.9, ease: 'power2.inOut' })
      .to('#target-notion', { scale: 1.08, transformOrigin: '50% 50%', yoyo: true, repeat: 1, duration: 0.45 });
    return tl;
  }

  function securityScene({ onStart, onComplete } = {}) {
    const gSecurity = document.getElementById('scene-security');
    const tl = gsap.timeline({ onStart, onComplete });
    if (!gSecurity) return tl;

    tl.to('#scene-notion', { opacity: 0, duration: 0.3 })
      .to(gSecurity, { opacity: 1, duration: 0.5 })
      .from('#shield', { scale: 0.6, transformOrigin: '50% 50%', opacity: 0, duration: 0.6, ease: 'back.out(1.6)' })
      .to('#shield', { rotation: 360, transformOrigin: '50% 50%', duration: 1.2, ease: 'power1.inOut' });
    return tl;
  }

  function typesScene({ onStart, onComplete } = {}) {
    const gTypes = document.getElementById('scene-types');
    const typeLabel = document.getElementById('type-label');
    const tl = gsap.timeline({ onStart, onComplete });
    if (!gTypes || !typeLabel) return tl;

    const titles = ['Project Tracker', 'Sales CRM', 'Analytics Board', 'Content Calendar', 'Team Dashboard'];
    tl.to('#scene-security', { opacity: 0, duration: 0.3 })
      .to(gTypes, { opacity: 1, duration: 0.5 })
      .from('#scene-types rect', { y: 10, opacity: 0, duration: 0.6, stagger: 0.08 });
    titles.forEach((t, i) => {
      tl.to(typeLabel, { text: t, duration: 0.4, ease: 'none' });
      tl.to('#scene-types rect', { scale: (i % 3) + 1.0, transformOrigin: '50% 50%', duration: 0.4, yoyo: true }, '<');
      tl.to({}, { duration: 0.6 });
    });
    return tl;
  }

  function signupScene({ onStart, onComplete } = {}) {
    const gSignup = document.getElementById('scene-signup');
    const mail = document.getElementById('mail');
    const sendBtn = document.getElementById('send-btn');
    const tl = gsap.timeline({ onStart, onComplete });
    if (!gSignup || !mail || !sendBtn) return tl;

    tl.to('#scene-types', { opacity: 0, duration: 0.3 })
      .to(gSignup, { opacity: 1, duration: 0.5 })
      .from(sendBtn, { scale: 0.9, opacity: 0, duration: 0.4 })
      .to(mail, { x: 140, y: 46, rotation: 10, duration: 0.8, ease: 'power2.inOut' })
      .add(() => {
        const rect = state.stage.getBoundingClientRect();
        particlesBurst({ x: rect.width * 0.62, y: rect.height * 0.46, color: '#10B981', count: state.prefersReducedMotion ? CONFIG.particles.minCount : CONFIG.particles.burstCount });
      })
      .to({}, { duration: 0.4 });
    return tl;
  }

  /**
   * Build master timeline in a reusable way.
   */
  function buildMasterTimeline() {
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
    tl.add(heroScene({}))
      .add(describeScene({}))
      .add(aiScene({}))
      .add(customizeScene({}))
      .add(noCodeScene({}))
      .add(notionScene({}))
      .add(securityScene({}))
      .add(typesScene({}))
      .add(signupScene({}));
    return tl;
  }

  /**
   * Ambient infinite promo loops — non-blocking, active only while demo is playing.
   */
  function startAmbientLoops() {
    if (state.ambientTL) return;
    const stage = state.stage;

    // Ensure Three is ready (on-demand init if user clicks very quickly)
    if (!state.startThree && hasTHREE && state.threeRoot && !state.prefersReducedMotion) {
      try { initThree(); } catch (_) {}
    }

    state.ambientTL = gsap.timeline({ repeat: -1, defaults: { ease: 'sine.inOut' } });
    state.ambientTL.to(stage, { boxShadow: '0 0 60px rgba(16,185,129,0.18)', duration: 3, yoyo: true }, 0);

    const blobs = document.querySelectorAll('#story .absolute.inset-0.pointer-events-none .absolute');
    if (blobs.length) {
      gsap.to(blobs, { xPercent: 8, yPercent: -6, duration: 14, yoyo: true, repeat: -1, ease: 'sine.inOut', stagger: { each: 2, yoyo: true } });
    }

    // Start gentle float only after hero unlocks
    if (!state.lockLogoCenter && document.getElementById('notion-logo') && !state.logoFloatTween) {
      state.logoFloatTween = gsap.to('#notion-logo', { y: '+=6', duration: 2.2, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    }

    const circuitPaths = state.svg ? state.svg.querySelectorAll('#ai-circuits path') : [];
    if (circuitPaths.length) {
      gsap.to(circuitPaths, { opacity: 0.45, duration: 1.2, yoyo: true, repeat: -1, stagger: 0.1 });
    }

    const schedule = () => {
      const baseMin = 2, baseMax = 3.5;
      const min = isSmallScreen() ? CONFIG.mobile.ambientMinDelay : baseMin;
      const max = isSmallScreen() ? CONFIG.mobile.ambientMaxDelay : baseMax;
      const delay = min + Math.random() * (max - min);
      state.ambientBurstDC = gsap.delayedCall(delay, () => {
        const rect = stage.getBoundingClientRect();
        const x = rect.width * (0.4 + Math.random() * 0.2);
        const y = rect.height * (0.35 + Math.random() * 0.3);
        particlesBurst({ x, y, color: Math.random() > 0.5 ? '#10B981' : '#34d399', count: state.prefersReducedMotion ? CONFIG.particles.minCount : (20 + Math.floor(Math.random() * 20)) });
        schedule();
      });
    };
    schedule();

    // Start Three.js loop only when ambient begins (i.e., when demo is active)
    if (state.startThree) state.startThree(); else requestAnimationFrame(() => { if (state.startThree) state.startThree(); });
  }

  function stopAmbientLoops() {
    if (state.ambientTL) { try { state.ambientTL.kill(); } catch (_) {} state.ambientTL = null; }
    if (state.ambientBurstDC) { try { state.ambientBurstDC.kill(); } catch (_) {} state.ambientBurstDC = null; }
    if (state.stopThree) state.stopThree();
    if (state.logoFloatTween) { try { state.logoFloatTween.kill(); } catch (_) {} state.logoFloatTween = null; }
  }

  /** Pause/resume control by scroll/visibility */
  function initVisibilityControls() {
    if (hasScrollTrigger) {
      ScrollTrigger.create({
        trigger: state.stage,
        start: 'top 80%',
        end: 'bottom top',
        onEnter: () => { /* only start ambient when playing */ },
        onLeave: () => {
          if (state.masterTL) {
            state.wasPlaying = !state.masterTL.paused();
            state.masterTL.pause();
            stopAmbientLoops();
          }
        },
        onEnterBack: () => {
          if (state.masterTL && state.wasPlaying) {
            startAmbientLoops();
            state.masterTL.play();
          }
        },
        onLeaveBack: () => {
          if (state.masterTL) {
            state.wasPlaying = !state.masterTL.paused();
            state.masterTL.pause();
            stopAmbientLoops();
          }
        },
      });
    } else {
      // Fallback: IntersectionObserver
      const io = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting && state.masterTL) {
            state.wasPlaying = !state.masterTL.paused();
            state.masterTL.pause();
            stopAmbientLoops();
          } else if (entry.isIntersecting && state.masterTL && state.wasPlaying) {
            startAmbientLoops();
            state.masterTL.play();
          }
        });
      }, { threshold: 0.1 });
      io.observe(state.stage);
      // Track cleanup properly
      trackCleanup(() => { try { io.disconnect(); } catch (_) {} });
    }

    const onVisibility = () => {
      if (document.hidden && state.masterTL) { state.wasPlaying = !state.masterTL.paused(); state.masterTL.pause(); stopAmbientLoops(); }
      else if (!document.hidden && state.masterTL && state.wasPlaying) { startAmbientLoops(); state.masterTL.play(); }
    };
    on(document, 'visibilitychange', onVisibility);

    // Orientation handling
    on(window, 'orientationchange', () => { if (hasScrollTrigger) requestAnimationFrame(() => ScrollTrigger.refresh()); }, { passive: true });

    // Resize observer to react to stage size changes
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        try {
          // Resize canvas to stage
          const rect = state.stage.getBoundingClientRect();
          if (state.fxCanvas) { state.fxCanvas.width = rect.width; state.fxCanvas.height = rect.height; }
          // Update three renderer size
          if (state.renderer && state.threeRoot) {
            const w = state.threeRoot.clientWidth;
            const h = state.threeRoot.clientHeight;
            state.renderer.setSize(w, h);
            if (state.camera) { state.camera.aspect = w / h; state.camera.updateProjectionMatrix(); }
          }
          if (hasScrollTrigger) ScrollTrigger.refresh();
        } catch (_) {}
      });
      ro.observe(state.stage);
      trackCleanup(() => { try { ro.disconnect(); } catch (_) {} });
    }
  }

  /** Build and wire master controls (no autoplay) */
  function wireControls() {
    // Build but do not autoplay
    if (!state.masterTL) {
      state.masterTL = buildMasterTimeline();
      state.masterTL.pause(0);
      if (state.prefersReducedMotion) state.masterTL.timeScale(CONFIG.reducedMotionScale);
    }

    const playBtn = document.getElementById('launch-demo');
    if (playBtn) {
      const onPlay = () => {
        if (!state.masterTL) return;
        startAmbientLoops();
        state.masterTL.play(0);
      };
      on(playBtn, 'click', onPlay, { passive: true });
    }
  }

  /** Public API */
  function exposeAPI() {
    window.NicerCinematic = {
      play() { if (state.masterTL) { startAmbientLoops(); state.masterTL.play(0); } },
      pause() { if (state.masterTL) { state.masterTL.pause(); stopAmbientLoops(); } },
      reset() { if (state.masterTL) { state.masterTL.pause(0); stopAmbientLoops(); } },
      setTimeScale(scale) { if (state.masterTL && typeof scale === 'number') state.masterTL.timeScale(scale); },
      isActive() { return !!(state.masterTL && state.masterTL.isActive()); },
      destroy() { teardown(); },
      rebuild() { teardown(); initialize(); },
      version: '1.1.0'
    };
  }

  /** Cleanup all resources */
  function teardown() {
    try { stopPerfMonitor(); } catch (_) {}
    try { stopAmbientLoops(); } catch (_) {}

    if (state.masterTL) { try { state.masterTL.kill(); } catch (_) {} state.masterTL = null; }
    if (hasScrollTrigger) {
      try { ScrollTrigger.getAll().forEach(t => t.kill()); } catch (_) {}
    }
    try { gsap.killTweensOf('*'); } catch (_) {}

    destroyThree();
    removeAllListeners();
    state.initialized = false;
  }

  /** Initialize the full system */
  function initialize() {
    if (state.initialized) return;
    state.initialized = true;

    state.prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Get refs
    state.stage = document.getElementById('cinematic-stage');
    state.svg = document.getElementById('story-svg');
    state.fxCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fx-canvas'));
    state.threeRoot = document.getElementById('three-root');

    if (!state.stage) {
      console.warn('[NicerCinematic] Stage not found. Aborting init.');
      return;
    }

    // Rendering hints scoped to the cinematic stage only (avoid global side-effects)
    gsap.set('#cinematic-stage *', { force3D: true, backfaceVisibility: 'hidden' });

    // Accessibility & immediate visibility
    applyAccessibilityAttributes();
    ensureImmediateVisibility();

    // Perf monitor (dev only)
    startPerfMonitor();

    // 3D background
    requestAnimationFrame(initThree);

    // Interactions & parallax
    initButtonInteractions();
    initParallax();

    // Build controls and visibility management (no autoplay)
    wireControls();
    initVisibilityControls();

    // Safety kill on unload
    on(window, 'beforeunload', () => {
      try { gsap.killTweensOf('*'); } catch (_) {}
      try { if (hasScrollTrigger) ScrollTrigger.getAll().forEach(t => t.kill()); } catch (_) {}
    });

    // Global error guard (do not break UX)
    on(window, 'error', (e) => console.warn('Animation error caught:', e.error || e.message));
  }

  // Initialize after DOM is ready but keep visual instantly responsive
  if (document.readyState === 'loading') {
    on(document, 'DOMContentLoaded', () => requestAnimationFrame(initialize));
  } else {
    requestAnimationFrame(initialize);
  }

  // Expose API immediately (methods will no-op until initialized)
  exposeAPI();
})(); 