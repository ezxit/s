// A brief brand entrance, isolated from the application's rendering and data.
(() => {
  const overlay = document.getElementById('entry-intro');
  const shell = document.querySelector('.site-shell');
  if (!overlay || !shell) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sessionKey = 'shortlink:intro-seen';
  const isReload = performance.getEntriesByType('navigation')[0]?.type === 'reload';
  let seen = false;
  try { seen = sessionStorage.getItem(sessionKey) === '1'; } catch {}
  if (motion.matches || (seen && !isReload)) { overlay.remove(); return; }
  try { sessionStorage.setItem(sessionKey, '1'); } catch {}

  const previousInert = shell.inert;
  const previousOverflow = document.body.style.overflow;
  let finished = false;
  let deadline;
  let fontDeadline;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    clearTimeout(fontDeadline);
    document.removeEventListener('keydown', skipOnKey, true);
    motion.removeEventListener('change', onMotionChange);
    shell.inert = previousInert;
    document.body.style.overflow = previousOverflow;
    overlay.remove();
  };
  const skipOnKey = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish();
  };
  const onMotionChange = () => { if (motion.matches) finish(); };

  shell.inert = true;
  document.body.style.overflow = 'hidden';
  overlay.hidden = false;
  overlay.addEventListener('click', finish);
  document.addEventListener('keydown', skipOnKey, true);
  motion.addEventListener('change', onMotionChange);
  overlay.addEventListener('animationend', event => {
    if (event.target === overlay && event.animationName === 'introVeil') finish();
  });
  // Always release the page, even when fonts or animation events are interrupted.
  deadline = setTimeout(finish, 4000);

  Promise.race([
    document.fonts.load('400 112px "Galaxie Copernicus"', 'Anderson').then(fonts => fonts.length > 0).catch(() => false),
    new Promise(resolve => { fontDeadline = setTimeout(() => resolve(false), 1200); })
  ]).then(fontReady => {
    clearTimeout(fontDeadline);
    if (finished) return;
    if (!fontReady) { finish(); return; }
    const tail = overlay.querySelector('.entry-intro-tail');
    overlay.style.setProperty('--intro-offset', `${tail.getBoundingClientRect().width / 2}px`);
    overlay.classList.add('is-playing');
  }).catch(finish);
})();
