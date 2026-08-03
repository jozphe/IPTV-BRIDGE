/* Shared theme behaviours: ember particle field, custom cursor, magnetic buttons */
(function () {
  /* ---------- Ember particle field ---------- */
  const canvas = document.getElementById('particles');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let w, h, particles, mouse = { x: -999, y: -999 };
    const COUNT = window.innerWidth < 640 ? 60 : 140;

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    }

    function makeParticle() {
      const ember = Math.random() < 0.45;
      // Bias spawn toward the top-right quadrant so the hero corner feels alive
      const topRight = Math.random() < 0.5;
      return {
        x: topRight ? w * (0.55 + Math.random() * 0.45) : Math.random() * w,
        y: topRight ? h * (Math.random() * 0.5) : Math.random() * h,
        r: Math.random() * (ember ? 2.4 : 1.4) + 0.4,
        vx: (Math.random() - 0.5) * 0.25,
        vy: -Math.random() * 0.35 - 0.05, // drift upward like sparks
        life: Math.random(),
        ember,
      };
    }

    function init() {
      resize();
      particles = Array.from({ length: COUNT }, makeParticle);
    }

    function step() {
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        // mouse repel
        const dx = p.x - mouse.x, dy = p.y - mouse.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 120) {
          p.x += (dx / dist) * 1.2;
          p.y += (dy / dist) * 1.2;
        }
        p.x += p.vx;
        p.y += p.vy;
        p.life += 0.004;

        // recycle when off-screen / faded
        if (p.y < -10 || p.life > 1) {
          Object.assign(p, makeParticle(), { y: h + 10, life: 0 });
        }

        const twinkle = 0.5 + Math.sin(p.life * Math.PI) * 0.5;
        if (p.ember) {
          ctx.fillStyle = `rgba(255,94,43,${0.8 * twinkle})`;
          ctx.shadowBlur = 14;
          ctx.shadowColor = 'rgba(255,94,43,0.9)';
        } else {
          ctx.fillStyle = `rgba(244,240,232,${0.4 * twinkle})`;
          ctx.shadowBlur = 0;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // faint constellation lines between nearby non-ember particles
      ctx.strokeStyle = 'rgba(244,240,232,0.05)';
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i], b = particles[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 110) {
            ctx.globalAlpha = 1 - d / 110;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(step);
    }

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
    window.addEventListener('mouseout', () => { mouse.x = -999; mouse.y = -999; });
    init();
    step();
  }

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
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      const mx = e.clientX - (r.left + r.width / 2), my = e.clientY - (r.top + r.height / 2);
      if (window.gsap) window.gsap.to(el, { x: mx * 0.3, y: my * 0.4, duration: 0.4, ease: 'power3.out' });
    });
    el.addEventListener('mouseleave', () => {
      if (window.gsap) window.gsap.to(el, { x: 0, y: 0, duration: 0.5, ease: 'elastic.out(1,0.4)' });
    });
  });

  /* ---------- Glass navbar on scroll ---------- */
  const nav = document.getElementById('nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }
})();
