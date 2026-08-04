/* Shared theme behaviours: custom cursor, magnetic buttons, glass nav */
(function () {
  /* ---------- Custom cursor ---------- */
  const cursor = document.getElementById('cursor');
  if (cursor) {
    let cx = innerWidth / 2, cy = innerHeight / 2, tx = cx, ty = cy;
    addEventListener('mousemove', (e) => { tx = e.clientX; ty = e.clientY; });
    (function loop() {
      cx += (tx - cx) * 0.2; cy += (ty - cy) * 0.2;
      cursor.style.left = cx + 'px'; cursor.style.top = cy + 'px';
      requestAnimationFrame(loop);
    })();
    document.querySelectorAll('[data-cursor-big]').forEach((el) => {
      el.addEventListener('mouseenter', () => cursor.classList.add('big'));
      el.addEventListener('mouseleave', () => cursor.classList.remove('big'));
    });
  }

  /* ---------- Magnetic buttons ---------- */
  document.querySelectorAll('[data-magnetic]').forEach((el) => {
    const reset = () => { if (window.gsap) window.gsap.to(el, { x: 0, y: 0, scale: 1, duration: 0.45, ease: 'power3.out' }); };
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      const mx = e.clientX - (r.left + r.width / 2), my = e.clientY - (r.top + r.height / 2);
      if (window.gsap) window.gsap.to(el, { x: mx * 0.18, y: my * 0.22, duration: 0.4, ease: 'power3.out' });
    });
    el.addEventListener('mouseleave', reset);
    // Snap back immediately on press/navigation so nothing is left drifting sideways
    el.addEventListener('mousedown', () => { if (window.gsap) window.gsap.to(el, { scale: 0.95, duration: 0.12, ease: 'power2.out' }); });
    el.addEventListener('mouseup', reset);
    el.addEventListener('click', reset);
  });

  /* ---------- Glass navbar on scroll ---------- */
  const nav = document.getElementById('nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }
})();
