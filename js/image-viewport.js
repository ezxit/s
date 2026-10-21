// Keep image gestures in viewport coordinates, independent of browser scrolling.
function createImageViewport(stage, image, onChange) {
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const pointers = new Map();
  let zoom = 1;
  let x = 0;
  let y = 0;
  let width = stage.clientWidth;
  let height = stage.clientHeight;
  let ready = false;
  let fitted = true;
  let drag = null;
  let pinch = null;
  let paintFrame = 0;
  let coastFrame = 0;
  let destroyed = false;
  let publishedState;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const limits = () => ({
    x: Math.max(0, (image.naturalWidth * zoom - width) / 2),
    y: Math.max(0, (image.naturalHeight * zoom - height) / 2)
  });
  const constrain = () => {
    const bounds = limits();
    x = clamp(x, -bounds.x, bounds.x);
    y = clamp(y, -bounds.y, bounds.y);
  };
  const publish = (force = false) => {
    if (!force && publishedState?.zoom === zoom && publishedState?.fitted === fitted && publishedState?.ready === ready) return;
    publishedState = { zoom, fitted, ready };
    onChange(publishedState);
  };
  const paint = () => {
    paintFrame = 0;
    if (destroyed || !ready) return;
    const left = (width - image.naturalWidth * zoom) / 2 + x;
    const top = (height - image.naturalHeight * zoom) / 2 + y;
    image.style.transform = `translate3d(${left}px, ${top}px, 0) scale(${zoom})`;
    const bounds = limits();
    stage.classList.toggle('can-pan', bounds.x > 0 || bounds.y > 0);
    publish();
  };
  const requestPaint = () => {
    if (!paintFrame && !destroyed) paintFrame = requestAnimationFrame(paint);
  };
  const stopCoast = () => {
    cancelAnimationFrame(coastFrame);
    coastFrame = 0;
  };
  const resetInteraction = () => {
    stopCoast();
    const ids = [...pointers.keys()];
    pointers.clear();
    drag = pinch = null;
    stage.classList.remove('is-panning');
    ids.forEach(id => { if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id); });
  };
  const fit = () => {
    resetInteraction();
    if (!ready) return;
    zoom = clamp(Math.floor(Math.min(1, width / image.naturalWidth, height / image.naturalHeight) * 100) / 100, 0.01, 5);
    x = y = 0;
    fitted = true;
    requestPaint();
  };
  const setZoom = (value, anchor) => {
    if (!ready || !Number.isFinite(value)) { publish(true); return; }
    resetInteraction();
    const rect = stage.getBoundingClientRect();
    const focalX = anchor ? anchor.clientX - rect.left - width / 2 : 0;
    const focalY = anchor ? anchor.clientY - rect.top - height / 2 : 0;
    const nextZoom = clamp(value, 0.01, 5);
    x = focalX - (focalX - x) * nextZoom / zoom;
    y = focalY - (focalY - y) * nextZoom / zoom;
    zoom = nextZoom;
    fitted = false;
    constrain();
    publish(true);
    requestPaint();
  };
  const pan = (dx, dy) => {
    if (!ready) return;
    resetInteraction();
    x += dx;
    y += dy;
    constrain();
    requestPaint();
  };
  const beginGesture = () => {
    drag = pinch = null;
    const points = [...pointers.values()];
    if (points.length >= 2) {
      const [a, b] = points;
      const rect = stage.getBoundingClientRect();
      pinch = {
        distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        zoom,
        imageX: ((a.x + b.x) / 2 - rect.left - width / 2 - x) / zoom,
        imageY: ((a.y + b.y) / 2 - rect.top - height / 2 - y) / zoom
      };
    } else if (points.length) {
      drag = { start: points[0], x, y, lastX: x, lastY: y, lastTime: performance.now(), vx: 0, vy: 0 };
    }
    stage.classList.toggle('is-panning', points.length > 0);
  };
  const resist = (value, bound) => {
    if (!bound) return 0;
    const edge = clamp(value, -bound, bound);
    const excess = value - edge;
    return edge + Math.sign(excess) * 90 * (1 - Math.exp(-Math.abs(excess) / 180));
  };
  const coast = (vx, vy) => {
    stopCoast();
    if (motionPreference.matches) { constrain(); requestPaint(); return; }
    let lastTime = performance.now();
    const started = lastTime;
    const stepAxis = (position, velocity, bound, dt) => {
      if (!bound) return [0, 0];
      const edge = clamp(position, -bound, bound);
      if (position !== edge) {
        velocity += (edge - position) * 0.0006 * dt;
        velocity *= Math.exp(-dt / 55);
      } else {
        velocity *= Math.exp(-dt / 260);
      }
      return [position + velocity * dt, velocity];
    };
    const step = now => {
      coastFrame = 0;
      if (destroyed || !ready) return;
      const dt = Math.min(32, now - lastTime);
      lastTime = now;
      const bounds = limits();
      [x, vx] = stepAxis(x, vx, bounds.x, dt);
      [y, vy] = stepAxis(y, vy, bounds.y, dt);
      const closeToBounds = Math.abs(x - clamp(x, -bounds.x, bounds.x)) < 0.5 && Math.abs(y - clamp(y, -bounds.y, bounds.y)) < 0.5;
      if (motionPreference.matches || now - started > 1600 || (Math.hypot(vx, vy) < 0.02 && closeToBounds)) {
        constrain();
        requestPaint();
        return;
      }
      requestPaint();
      coastFrame = requestAnimationFrame(step);
    };
    coastFrame = requestAnimationFrame(step);
  };
  const pointerDown = event => {
    if (!ready || (event.pointerType !== 'touch' && event.button !== 0)) return;
    event.preventDefault();
    stopCoast();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    stage.setPointerCapture(event.pointerId);
    if (event.pointerType === 'mouse') stage.focus({ preventScroll: true });
    beginGesture();
  };
  const pointerMove = event => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.values()];
    if (pinch && points.length >= 2) {
      const [a, b] = points;
      const rect = stage.getBoundingClientRect();
      zoom = clamp(pinch.zoom * Math.hypot(b.x - a.x, b.y - a.y) / pinch.distance, 0.01, 5);
      x = (a.x + b.x) / 2 - rect.left - width / 2 - pinch.imageX * zoom;
      y = (a.y + b.y) / 2 - rect.top - height / 2 - pinch.imageY * zoom;
      fitted = false;
      constrain();
    } else if (drag) {
      const bounds = limits();
      const nextX = drag.x + points[0].x - drag.start.x;
      const nextY = drag.y + points[0].y - drag.start.y;
      x = event.pointerType === 'mouse' ? clamp(nextX, -bounds.x, bounds.x) : resist(nextX, bounds.x);
      y = event.pointerType === 'mouse' ? clamp(nextY, -bounds.y, bounds.y) : resist(nextY, bounds.y);
      const now = performance.now();
      const dt = Math.max(8, now - drag.lastTime);
      drag.vx = dt > 80 ? 0 : drag.vx * 0.4 + clamp((x - drag.lastX) / dt, -3, 3) * 0.6;
      drag.vy = dt > 80 ? 0 : drag.vy * 0.4 + clamp((y - drag.lastY) / dt, -3, 3) * 0.6;
      drag.lastX = x;
      drag.lastY = y;
      drag.lastTime = now;
    }
    requestPaint();
  };
  const pointerEnd = event => {
    if (!pointers.has(event.pointerId)) return;
    const releasedDrag = drag;
    pointers.delete(event.pointerId);
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    beginGesture(); // Rebase on 2 → 1 fingers so the remaining finger never jumps.
    if (pointers.size) return;
    if (event.type === 'pointerup' && event.pointerType !== 'mouse') {
      const recent = releasedDrag && performance.now() - releasedDrag.lastTime < 80;
      coast(recent ? releasedDrag.vx : 0, recent ? releasedDrag.vy : 0);
    } else {
      constrain();
      requestPaint();
    }
  };
  const wheel = event => {
    if (!ready) return;
    event.preventDefault();
    if (event.ctrlKey) {
      if (event.deltaY) setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event);
    } else {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      pan(-dx * unit, -dy * unit);
    }
  };
  stage.addEventListener('pointerdown', pointerDown);
  stage.addEventListener('pointermove', pointerMove);
  stage.addEventListener('pointerup', pointerEnd);
  stage.addEventListener('pointercancel', pointerEnd);
  stage.addEventListener('lostpointercapture', pointerEnd);
  stage.addEventListener('wheel', wheel, { passive: false });
  const observer = new ResizeObserver(() => {
    const nextWidth = stage.clientWidth;
    const nextHeight = stage.clientHeight;
    if (nextWidth === width && nextHeight === height) return;
    width = nextWidth;
    height = nextHeight;
    resetInteraction();
    if (!ready) return;
    if (fitted) fit();
    else { constrain(); requestPaint(); }
  });
  observer.observe(stage);

  return {
    get zoom() { return zoom; },
    setZoom,
    fit,
    pan,
    load() {
      ready = true;
      width = stage.clientWidth;
      height = stage.clientHeight;
      image.style.width = `${image.naturalWidth}px`;
      image.style.height = `${image.naturalHeight}px`;
      fit();
    },
    reset() {
      resetInteraction();
      cancelAnimationFrame(paintFrame);
      paintFrame = 0;
      ready = false;
      fitted = true;
      x = y = 0;
      stage.classList.remove('can-pan');
      publish();
    },
    destroy() {
      destroyed = true;
      resetInteraction();
      cancelAnimationFrame(paintFrame);
      observer.disconnect();
      stage.removeEventListener('pointerdown', pointerDown);
      stage.removeEventListener('pointermove', pointerMove);
      stage.removeEventListener('pointerup', pointerEnd);
      stage.removeEventListener('pointercancel', pointerEnd);
      stage.removeEventListener('lostpointercapture', pointerEnd);
      stage.removeEventListener('wheel', wheel);
    }
  };
}
