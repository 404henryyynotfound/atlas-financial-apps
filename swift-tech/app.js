/* Swift Technologies — dependency-free interactions and a raw WebGL hero field. */
(function () {
  'use strict';

  var doc = document;
  var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var coarseQuery = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
  var dismissMenu = function () {};

  function reduced() {
    return !!(motionQuery && motionQuery.matches);
  }

  function onQueryChange(query, handler) {
    if (!query) return;
    if (query.addEventListener) {
      query.addEventListener('change', handler);
    } else if (query.addListener) {
      query.addListener(handler);
    }
  }

  function formatNumber(value) {
    try {
      return value.toLocaleString('en-US');
    } catch (error) {
      return String(value);
    }
  }

  /* ---------- Responsive navigation ---------- */

  function initNavigation() {
    var button = doc.querySelector('.menu-button');
    var nav = doc.getElementById('main-nav');
    if (!button || !nav) return;

    function setOpen(open) {
      nav.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }

    dismissMenu = function () { setOpen(false); };

    button.addEventListener('click', function () {
      setOpen(button.getAttribute('aria-expanded') !== 'true');
    });

    doc.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' || event.key === 'Esc') setOpen(false);
    });

    doc.addEventListener('click', function (event) {
      if (!nav.contains(event.target) && !button.contains(event.target)) setOpen(false);
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 880) setOpen(false);
    }, { passive: true });
  }

  function initAnchors() {
    var links = Array.prototype.slice.call(doc.querySelectorAll('a[href^="#"]'));
    links.forEach(function (link) {
      link.addEventListener('click', function (event) {
        var hash = link.getAttribute('href');
        if (!hash || hash === '#') return;
        var target = doc.getElementById(hash.slice(1));
        if (!target) return;

        event.preventDefault();
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
        if (window.history && window.history.replaceState) window.history.replaceState(null, '', hash);
        try {
          target.focus({ preventScroll: true });
        } catch (error) {
          target.focus();
        }
        dismissMenu();
      });
    });
  }

  function initHeader() {
    var header = doc.getElementById('masthead');
    if (!header) return;
    var queued = false;

    function update() {
      header.classList.toggle('is-scrolled', window.scrollY > 12);
      queued = false;
    }

    window.addEventListener('scroll', function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(update);
    }, { passive: true });
    update();
  }

  /* ---------- Scroll reveals ---------- */

  function initReveals() {
    var items = Array.prototype.slice.call(doc.querySelectorAll('.reveal'));
    if (!items.length) return;

    if (!('IntersectionObserver' in window) || reduced()) {
      items.forEach(function (item) { item.classList.add('is-visible'); });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });

    items.forEach(function (item) { observer.observe(item); });
  }

  /* ---------- Illustrative counters ---------- */

  function initCounters() {
    var counters = Array.prototype.slice.call(doc.querySelectorAll('[data-counter]'));
    if (!counters.length) return;

    function finish(element, value) {
      element.textContent = formatNumber(value);
      element.setAttribute('data-done', '1');
    }

    function play(element) {
      if (element.getAttribute('data-done') === '1') return;
      var target = parseInt(element.getAttribute('data-to'), 10);
      if (isNaN(target)) target = 0;

      if (reduced() || target === 0 || !window.requestAnimationFrame) {
        finish(element, target);
        return;
      }

      element.textContent = '0';
      var duration = Math.max(300, parseInt(element.getAttribute('data-duration'), 10) || 1400);
      var start = null;

      function tick(now) {
        if (start === null) start = now;
        var progress = Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - progress, 3);
        element.textContent = formatNumber(Math.round(target * eased));
        if (progress < 1) {
          window.requestAnimationFrame(tick);
        } else {
          finish(element, target);
        }
      }

      // Mark as started before the first frame so a second observer hit cannot restart it.
      element.setAttribute('data-done', '1');
      window.requestAnimationFrame(tick);
    }

    if (!('IntersectionObserver' in window) || reduced()) {
      counters.forEach(function (element) {
        var value = parseInt(element.getAttribute('data-to'), 10);
        finish(element, isNaN(value) ? 0 : value);
      });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          play(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.35 });

    counters.forEach(function (element) { observer.observe(element); });
  }

  /* ---------- Copy buttons ---------- */

  function legacyCopy(text) {
    var field = doc.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    doc.body.appendChild(field);
    field.select();
    var copied = false;
    try {
      copied = doc.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    doc.body.removeChild(field);
    return copied;
  }

  function initCopyButtons() {
    var buttons = Array.prototype.slice.call(doc.querySelectorAll('[data-copy-target]'));
    buttons.forEach(function (button) {
      var label = button.querySelector('.copy-button__label');
      var original = label ? label.textContent : 'Copy';

      button.addEventListener('click', function () {
        var source = doc.getElementById(button.getAttribute('data-copy-target'));
        if (!source) return;
        var text = source.textContent.trim();

        function complete(copied) {
          if (label) label.textContent = copied ? 'Copied' : 'Copy failed';
          button.classList.toggle('is-copied', !!copied);
          if (button.copyTimer) window.clearTimeout(button.copyTimer);
          button.copyTimer = window.setTimeout(function () {
            if (label) label.textContent = original;
            button.classList.remove('is-copied');
          }, 1800);
        }

        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(function () { complete(true); }, function () { complete(legacyCopy(text)); });
        } else {
          complete(legacyCopy(text));
        }
      });
    });
  }

  /* ---------- WebGL signal field ---------- */

  var vertexSource = [
    'attribute vec2 a_position;',
    'varying vec2 v_uv;',
    'void main() {',
    '  v_uv = a_position * 0.5 + 0.5;',
    '  gl_Position = vec4(a_position, 0.0, 1.0);',
    '}'
  ].join('\n');

  var fragmentSource = [
    'precision mediump float;',
    'uniform vec2 u_resolution;',
    'uniform float u_time;',
    'uniform float u_motion;',
    'uniform vec2 u_pointer;',
    'varying vec2 v_uv;',
    'float hairline(float value, float width) {',
    '  return 1.0 - smoothstep(0.0, width, abs(value));',
    '}',
    'void main() {',
    '  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / max(u_resolution.y, 1.0);',
    '  float t = u_time * u_motion;',
    '  vec2 leftNode = vec2(-0.52, 0.07 + u_pointer.y * 0.035);',
    '  vec2 rightNode = vec2(0.56, -0.11 + u_pointer.x * 0.035);',
    '  float dLeft = length(p - leftNode);',
    '  float dRight = length(p - rightNode);',
    '  float foldLeft = abs(p.x - leftNode.x) * 0.78;',
    '  float foldRight = abs(p.x - rightNode.x) * 0.62;',
    '  float waveLeft = sin((dLeft + foldLeft) * 26.0 - t * 2.0);',
    '  float waveRight = sin((dRight + foldRight) * 21.0 + t * 1.5);',
    '  float ridgeLeft = pow(max(waveLeft, 0.0), 8.0);',
    '  float ridgeRight = pow(max(waveRight, 0.0), 9.0);',
    '  vec2 grid = p * 7.5;',
    '  grid.x += sin(grid.y * 0.7 + t * 0.16) * 0.18;',
    '  float lines = max(hairline(sin(grid.x * 3.14159), 0.11), hairline(sin(grid.y * 3.14159), 0.1));',
    '  float packet = pow(max(0.0, sin(dLeft * 9.0 - t * 1.1 + atan(p.y, p.x) * 2.0)), 16.0);',
    '  vec3 navy = vec3(0.019, 0.035, 0.071);',
    '  vec3 cyan = vec3(0.133, 0.827, 0.933);',
    '  vec3 indigo = vec3(0.388, 0.400, 0.945);',
    '  vec3 violet = vec3(0.659, 0.333, 0.969);',
    '  vec3 col = navy;',
    '  col += indigo * ridgeLeft * 0.42;',
    '  col += violet * ridgeRight * 0.34;',
    '  col += cyan * lines * 0.1;',
    '  col += cyan * packet * 0.18;',
    '  col += indigo * exp(-length(p - vec2(0.0, 0.02)) * 2.1) * 0.12;',
    '  float vignette = 1.0 - smoothstep(0.18, 1.35, length(p));',
    '  col *= mix(0.42, 1.0, vignette);',
    '  col *= mix(0.82, 1.0, v_uv.y);',
    '  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;',
    '  col += grain * 0.014;',
    '  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);',
    '}'
  ].join('\n');

  function compile(gl, type, source) {
    var shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      if (window.console && console.warn) console.warn('Swift: shader compile failed', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function buildProgram(gl) {
    var vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    var fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      return null;
    }

    var program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      return null;
    }

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.detachShader(program, vertex);
    gl.detachShader(program, fragment);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (window.console && console.warn) console.warn('Swift: shader link failed', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  function initSignalField() {
    var hero = doc.querySelector('.hero');
    var canvas = doc.getElementById('signal-canvas');
    if (!hero || !canvas) return;

    var gl = null;
    try {
      var options = {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        powerPreference: 'high-performance'
      };
      gl = canvas.getContext('webgl', options) || canvas.getContext('experimental-webgl', options);
    } catch (error) {
      gl = null;
    }
    if (!gl) return; // The CSS gradient remains visible.

    var program = buildProgram(gl);
    if (!program) return;

    var buffer = gl.createBuffer();
    if (!buffer) {
      gl.deleteProgram(program);
      return;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    var position = gl.getAttribLocation(program, 'a_position');
    if (position < 0) {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      return;
    }
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    var uniforms = {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      time: gl.getUniformLocation(program, 'u_time'),
      motion: gl.getUniformLocation(program, 'u_motion'),
      pointer: gl.getUniformLocation(program, 'u_pointer')
    };

    var width = 0;
    var height = 0;
    var elapsed = 0;
    var previous = 0;
    var frameId = 0;
    var running = false;
    var onScreen = true;
    var disposed = false;
    var pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    function draw(time) {
      if (disposed) return;
      pointer.x += (pointer.tx - pointer.x) * 0.04;
      pointer.y += (pointer.ty - pointer.y) * 0.04;
      if (uniforms.time) gl.uniform1f(uniforms.time, time);
      if (uniforms.motion) gl.uniform1f(uniforms.motion, reduced() ? 0 : 1);
      if (uniforms.pointer) gl.uniform2f(uniforms.pointer, pointer.x, pointer.y);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function frame(now) {
      if (!running) return;
      if (previous) elapsed += Math.min((now - previous) / 1000, 0.05);
      previous = now;
      draw(elapsed);
      frameId = window.requestAnimationFrame(frame);
    }

    function start() {
      if (running || disposed || reduced() || doc.hidden || !onScreen) return;
      running = true;
      previous = 0;
      frameId = window.requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = 0;
      previous = 0;
    }

    function sync() {
      if (disposed) return;
      if (reduced()) {
        stop();
        draw(0);
        return;
      }
      if (doc.hidden || !onScreen) {
        stop();
        return;
      }
      start();
    }

    function resize() {
      if (disposed) return;
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      var nextWidth = Math.max(1, Math.round(rect.width * dpr));
      var nextHeight = Math.max(1, Math.round(rect.height * dpr));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      if (uniforms.resolution) gl.uniform2f(uniforms.resolution, width, height);
      draw(elapsed);
    }

    resize();
    draw(0);
    hero.classList.add('has-webgl');

    var resizeObserver = null;
    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(function () { resize(); });
      resizeObserver.observe(canvas);
    }
    window.addEventListener('resize', resize, { passive: true });
    onQueryChange(motionQuery, sync);
    doc.addEventListener('visibilitychange', sync);

    if ('IntersectionObserver' in window) {
      var visibility = new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        sync();
      }, { threshold: 0 });
      visibility.observe(hero);
    }

    if (coarseQuery && !coarseQuery.matches) {
      hero.addEventListener('pointermove', function (event) {
        var rect = hero.getBoundingClientRect();
        pointer.tx = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
        pointer.ty = (0.5 - (event.clientY - rect.top) / rect.height) * 2;
      }, { passive: true });
      hero.addEventListener('pointerleave', function () {
        pointer.tx = 0;
        pointer.ty = 0;
      }, { passive: true });
    }

    canvas.addEventListener('webglcontextlost', function (event) {
      event.preventDefault();
      disposed = true;
      stop();
      hero.classList.remove('has-webgl');
    }, false);

    window.addEventListener('pagehide', function (event) {
      if (event.persisted) return;
      disposed = true;
      stop();
      if (resizeObserver) resizeObserver.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    }, false);

    sync();
  }

  function initYear() {
    var year = doc.querySelector('[data-year]');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  function init() {
    initNavigation();
    initAnchors();
    initHeader();
    initReveals();
    initCounters();
    initCopyButtons();
    initSignalField();
    initYear();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
