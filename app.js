(function () {
  "use strict";

  const cfg = window.APP_CONFIG;
  const QUOTES = window.APP_QUOTES || [];
  const LEVEL = cfg.levelSize || 1000000;
  const MS_PER_DAY = 86400000;
  const DAYS_PER_MONTH = 30.44;

  const $ = (id) => document.getElementById(id);

  const fmtILS = new Intl.NumberFormat("he-IL", {
    style: "currency", currency: "ILS", maximumFractionDigits: 0,
  });
  const fmtNum = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });
  const fmtDate = new Intl.DateTimeFormat("he-IL", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const fmtMonthYear = new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" });
  const fmtShortDate = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", year: "numeric" });

  function fmtCompact(v) {
    if (v >= 1000000) {
      const m = v / 1000000;
      return (Number.isInteger(m) ? m : m.toFixed(1)) + "M";
    }
    return Math.round(v / 1000) + "K";
  }

  /* ---------- מצב תצוגה ---------- */

  const params = new URLSearchParams(location.search);
  const forced = params.get("mode");
  const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const mode = forced === "tv" || forced === "edit"
    ? forced
    : (window.innerWidth >= 1000 && !isTouch ? "tv" : "edit");

  $(mode === "tv" ? "tv" : "edit").classList.remove("hidden");

  /* ---------- אחסון: Firebase או מקומי ---------- */

  const LOCAL_KEY = "onemill-entries";
  let entries = [];
  let prevTotal = null;
  let saveFn = null;

  function normalize(raw) {
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    return list
      .filter((e) => e && typeof e.total === "number" && e.date)
      .sort((a, b) => (a.date === b.date ? (a.ts || 0) - (b.ts || 0) : a.date < b.date ? -1 : 1));
  }

  function setSyncState(text) {
    const a = $("sync-state"), b = $("sync-state-tv");
    if (a) a.textContent = text;
    if (b) b.textContent = text;
  }

  function initLocalStore() {
    saveFn = (list) => {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
      onData(list);
    };
    window.addEventListener("storage", (ev) => {
      if (ev.key === LOCAL_KEY) onData(JSON.parse(ev.newValue || "[]"));
    });
    setSyncState("מצב מקומי (ללא סנכרון) — ראה SETUP.md");
    onData(JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]"));
  }

  // סנכרון דרך /api/data (Vercel + Upstash Redis) — הטלפון שומר,
  // הטלוויזיה מושכת עדכונים כל 5 שניות
  async function initApiStore() {
    const apiUrl = "/api/data?id=" + encodeURIComponent(cfg.dataId);
    try {
      const r = await fetch(apiUrl, { cache: "no-store" });
      if (!r.ok) throw new Error("api " + r.status);
      const list = await r.json();
      saveFn = (l) => {
        onData(l); // עדכון מיידי על המסך, השמירה ברקע
        fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(l),
        }).catch(() => setSyncState("שגיאת שמירה — נסה שוב"));
      };
      setSyncState("מסונכרן ☁");
      onData(list);
      setInterval(async () => {
        try {
          const r2 = await fetch(apiUrl, { cache: "no-store" });
          if (!r2.ok) return;
          const l2 = await r2.json();
          if (JSON.stringify(l2) !== JSON.stringify(entries)) onData(l2);
          setSyncState("מסונכרן ☁");
        } catch { setSyncState("מתחבר…"); }
      }, 5000);
    } catch {
      initLocalStore();
    }
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function initFirebaseStore() {
    try {
      const v = "10.14.1";
      await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
      await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-database-compat.js`);
      firebase.initializeApp(cfg.firebase);
      const ref = firebase.database().ref("savings/" + cfg.dataId + "/entries");
      saveFn = (list) => ref.set(list);
      ref.on("value", (snap) => {
        setSyncState("מסונכרן ☁");
        onData(snap.val() || []);
      });
      firebase.database().ref(".info/connected").on("value", (snap) => {
        setSyncState(snap.val() ? "מסונכרן ☁" : "מתחבר…");
      });
    } catch (err) {
      console.warn("Firebase נכשל, עובר למצב מקומי:", err);
      initLocalStore();
    }
  }

  /* ---------- מצב אורחים: הסתרת המסך מרחוק ---------- */

  const PRIVACY_LOCAL_KEY = "onemill-privacy";
  let privacyHidden = false;
  let applyPrivacy = () => {};
  let privacyStore = null;

  async function initPrivacyStore() {
    const apiUrl = "/api/flag?id=" + encodeURIComponent(cfg.dataId);
    try {
      const r = await fetch(apiUrl, { cache: "no-store" });
      if (!r.ok) throw new Error("flag " + r.status);
      const state = await r.json();
      applyPrivacy(!!state.hidden);
      setInterval(async () => {
        try {
          const r2 = await fetch(apiUrl, { cache: "no-store" });
          if (!r2.ok) return;
          const s2 = await r2.json();
          applyPrivacy(!!s2.hidden);
        } catch { /* ננסה שוב בפעימה הבאה */ }
      }, 4000);
      return {
        setHidden(hidden) {
          applyPrivacy(hidden);
          fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hidden }),
          }).catch(() => {});
        },
      };
    } catch {
      // אין /api בהרצה מקומית — נופל למצב מקומי (אותו דפדפן בלבד, לבדיקות)
      applyPrivacy(localStorage.getItem(PRIVACY_LOCAL_KEY) === "1");
      window.addEventListener("storage", (ev) => {
        if (ev.key === PRIVACY_LOCAL_KEY) applyPrivacy(ev.newValue === "1");
      });
      return {
        setHidden(hidden) {
          localStorage.setItem(PRIVACY_LOCAL_KEY, hidden ? "1" : "0");
          applyPrivacy(hidden);
        },
      };
    }
  }

  /* ---------- חישובים ---------- */

  function currentTotal() {
    return entries.length ? entries[entries.length - 1].total : 0;
  }

  // הרמה הנוכחית: לפני המיליון — תחנות הביניים; אחרי — רמות של מיליון
  function levelInfo(total) {
    if (total < LEVEL) {
      return {
        start: 0, end: LEVEL,
        name: "רמה 1 · בדרך למיליון הראשון",
        forecastLabel: "תחזית הגעה למיליון",
      };
    }
    const n = Math.floor(total / LEVEL); // כמה מיליונים הושלמו
    return {
      start: n * LEVEL, end: (n + 1) * LEVEL,
      name: `רמה ${n + 1} · בדרך ל-${fmtCompact((n + 1) * LEVEL)}`,
      forecastLabel: `תחזית הגעה ל-${fmtCompact((n + 1) * LEVEL)}`,
    };
  }

  // כל ספי החגיגה: תחנות הביניים + כל כפולת מיליון
  function crossedMilestone(oldT, newT) {
    const thresholds = [...cfg.milestones];
    for (let m = 2 * LEVEL; m <= newT + LEVEL; m += LEVEL) thresholds.push(m);
    let best = null;
    for (const t of thresholds) if (oldT < t && t <= newT) best = t;
    return best;
  }

  // קצב חודשי: חלון של עד 6 חודשים אחורה מהעדכון האחרון
  function monthlyRate() {
    if (entries.length < 2) return null;
    const last = entries[entries.length - 1];
    const lastMs = new Date(last.date).getTime();
    const cutoff = lastMs - 183 * MS_PER_DAY;
    let start = entries[0];
    for (const e of entries) {
      if (new Date(e.date).getTime() >= cutoff) break;
      start = e;
    }
    if (start === last) start = entries[0];
    const months = Math.max((lastMs - new Date(start.date).getTime()) / MS_PER_DAY / DAYS_PER_MONTH, 0.5);
    const rate = (last.total - start.total) / months;
    return rate > 0 ? rate : null;
  }

  function forecastDate(rate, total, end) {
    if (!rate) return null;
    const monthsLeft = (end - total) / rate;
    return new Date(Date.now() + monthsLeft * DAYS_PER_MONTH * MS_PER_DAY);
  }

  /* ---------- רנדור: תצוגת TV ---------- */

  const RING_C = 2 * Math.PI * 88;
  let shownTotal = 0;
  let countAnim = null;

  function countUp(target) {
    if (countAnim) cancelAnimationFrame(countAnim);
    const from = shownTotal, diff = target - from, t0 = performance.now(), dur = 1500;
    function step(t) {
      const p = Math.min((t - t0) / dur, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      shownTotal = from + diff * ease;
      $("total").textContent = fmtNum.format(Math.round(shownTotal));
      if (p < 1) countAnim = requestAnimationFrame(step);
    }
    countAnim = requestAnimationFrame(step);
  }

  function renderMilestones(total) {
    const holder = $("milestones");
    holder.innerHTML = "";
    let items;
    if (total < LEVEL) {
      items = cfg.milestones.map((v) => ({ value: v, label: fmtCompact(v), star: v === LEVEL }));
    } else {
      const n = Math.floor(total / LEVEL);
      const first = Math.max(1, n - 2);
      items = [];
      for (let i = first; i <= first + 4; i++) {
        items.push({ value: i * LEVEL, label: fmtCompact(i * LEVEL), star: true });
      }
    }
    let currentMarked = false;
    for (const it of items) {
      const div = document.createElement("div");
      div.className = "ms" + (total >= it.value ? " done" : "");
      if (total < it.value && !currentMarked) { div.classList.add("current"); currentMarked = true; }
      div.innerHTML =
        `<div class="ms-dot"></div><div class="ms-label">${it.label}</div>` +
        (it.star ? `<div class="ms-star">🏠</div>` : "");
      holder.appendChild(div);
    }
  }

  function renderTV() {
    const total = currentTotal();
    const lv = levelInfo(total);
    const pct = Math.min((total - lv.start) / (lv.end - lv.start), 1);

    $("goal-name").textContent = cfg.goalName;
    countUp(total);
    $("percent").textContent = Math.floor(pct * 100) + "%";
    $("level-name").textContent = lv.name;
    $("ring-fill").style.strokeDashoffset = RING_C * (1 - pct);

    renderMilestones(total);

    const rate = monthlyRate();
    $("rate").textContent = rate ? fmtILS.format(Math.round(rate)) : "—";
    $("forecast-label").textContent = lv.forecastLabel;
    const fc = forecastDate(rate, total, lv.end);
    $("forecast").textContent = fc ? fmtMonthYear.format(fc) : "—";

    drawSpark();
  }

  /* ---------- גרף התקדמות (sparkline) ---------- */

  let sparkPts = [];

  function drawSpark() {
    const svg = $("spark");
    if (!svg || mode !== "tv") return;
    const box = svg.parentElement.getBoundingClientRect();
    const W = Math.max(box.width, 40), H = Math.max(box.height, 30);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = "";
    sparkPts = [];
    if (!entries.length) return;

    const fontPx = Math.max(10, Math.round(H * 0.13)); // קריא גם מרחוק
    const padY = 8, padL = 4, padR = fontPx * 4; // מקום לתווית ערך אחרונה בצד
    const times = entries.map((e) => new Date(e.date).getTime());
    const vals = entries.map((e) => e.total);
    const t0 = Math.min(...times), t1 = Math.max(...times);
    const v0 = Math.min(...vals) * 0.97, v1 = Math.max(...vals) * 1.03 || 1;
    const x = (t) => t1 === t0 ? W / 2 : padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
    const y = (v) => H - padY - ((v - v0) / (v1 - v0)) * (H - 2 * padY);

    const NS = "http://www.w3.org/2000/svg";
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };

    // קו-עזר אופקי אחד בערך עגול
    const mid = (v0 + v1) / 2;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(mid, 1))));
    const gridV = Math.round(mid / pow) * pow;
    if (gridV > v0 && gridV < v1) {
      svg.appendChild(el("line", {
        x1: 0, x2: W - padR + 12, y1: y(gridV), y2: y(gridV),
        stroke: "var(--grid)", "stroke-width": 1,
      }));
      const gl = el("text", {
        x: W - padR + 14, y: y(gridV) + 3, fill: "var(--text-muted)",
        "font-size": fontPx, "text-anchor": "start",
      });
      gl.textContent = fmtCompact(gridV);
      svg.appendChild(gl);
    }

    const pts = entries.map((e) => ({ px: x(new Date(e.date).getTime()), py: y(e.total), e }));
    sparkPts = pts;

    if (pts.length >= 2) {
      const lineD = pts.map((p, i) => (i ? "L" : "M") + p.px + " " + p.py).join(" ");
      const areaD = lineD + ` L ${pts[pts.length - 1].px} ${H - 2} L ${pts[0].px} ${H - 2} Z`;
      svg.appendChild(el("path", { d: areaD, fill: "var(--accent)", opacity: 0.1 }));
      svg.appendChild(el("path", {
        d: lineD, fill: "none", stroke: "var(--accent)",
        "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
    }

    // נקודת סיום עם טבעת בצבע המשטח + תווית ערך (תווית אחת בלבד, בטקסט — לא בצבע הסדרה)
    const lastP = pts[pts.length - 1];
    svg.appendChild(el("circle", {
      cx: lastP.px, cy: lastP.py, r: 5, fill: "var(--accent-bright)",
      stroke: "var(--surface)", "stroke-width": 2,
    }));
    const lbl = el("text", {
      x: lastP.px + 8, y: lastP.py + 4, fill: "var(--text-secondary)",
      "font-size": fontPx, "font-weight": 600, "text-anchor": "start",
    });
    lbl.textContent = fmtCompact(lastP.e.total);
    svg.appendChild(lbl);
  }

  // ריחוף עכבר על הגרף (לשימוש במחשב; בטלוויזיה אין סמן)
  (function sparkHover() {
    const svg = $("spark"), tip = $("spark-tip");
    if (!svg || !tip) return;
    svg.addEventListener("mousemove", (ev) => {
      if (!sparkPts.length) return;
      const r = svg.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      let best = sparkPts[0];
      for (const p of sparkPts) if (Math.abs(p.px - mx) < Math.abs(best.px - mx)) best = p;
      tip.innerHTML = `<div>${fmtILS.format(best.e.total)}</div>` +
        `<div class="tip-date">${fmtShortDate.format(new Date(best.e.date))}</div>`;
      tip.classList.remove("hidden");
      const card = svg.closest(".spark-card").getBoundingClientRect();
      tip.style.left = Math.min(best.px + (r.left - card.left), card.width - 90) + "px";
      tip.style.top = "4px";
    });
    svg.addEventListener("mouseleave", () => tip.classList.add("hidden"));
  })();

  /* ---------- רנדור: תצוגת עריכה ---------- */

  let entryMode = "deposit";

  function renderEdit() {
    const total = currentTotal();
    const lv = levelInfo(total);
    $("edit-total-value").textContent = fmtNum.format(total);

    const nextMs = total < LEVEL
      ? cfg.milestones.find((m) => m > total) || LEVEL
      : lv.end;
    $("edit-sub").textContent = `היעד הבא: ${fmtILS.format(nextMs)} · חסרים ${fmtILS.format(nextMs - total)}`;
    $("edit-bar-fill").style.width = Math.min(((total - lv.start) / (lv.end - lv.start)) * 100, 100) + "%";

    const ul = $("entries-list");
    ul.innerHTML = "";
    $("entries-empty").style.display = entries.length ? "none" : "";
    [...entries].reverse().forEach((e, ri) => {
      const idx = entries.length - 1 - ri;
      const prev = idx > 0 ? entries[idx - 1].total : 0;
      const delta = e.total - prev;
      const li = document.createElement("li");
      li.className = "entry";
      li.innerHTML =
        `<div class="entry-info">
           <div class="entry-total">${fmtILS.format(e.total)}</div>
           <div class="entry-date">${fmtShortDate.format(new Date(e.date))}</div>
         </div>
         <span class="entry-delta ${delta < 0 ? "neg" : ""}">${delta >= 0 ? "+" : ""}${fmtILS.format(delta)}</span>
         <button class="entry-del" title="מחיקה" aria-label="מחיקה">✕</button>`;
      li.querySelector(".entry-del").addEventListener("click", () => {
        if (confirm("למחוק את העדכון הזה?")) {
          entries.splice(idx, 1);
          saveFn(entries);
        }
      });
      ul.appendChild(li);
    });
  }

  function setupEditForm() {
    $("entry-date").value = new Date().toISOString().slice(0, 10);

    // עיצוב חי עם פסיקים בזמן הקלדה (5000 → 5,000)
    $("amount").addEventListener("input", (ev) => {
      const digits = ev.target.value.replace(/[^\d]/g, "");
      ev.target.value = digits ? fmtNum.format(Number(digits)) : "";
    });

    const segD = $("seg-deposit"), segT = $("seg-total");
    function setSeg(m) {
      entryMode = m;
      segD.classList.toggle("active", m === "deposit");
      segT.classList.toggle("active", m === "total");
      $("amount-label").textContent = m === "deposit" ? "כמה הפקדת? (₪)" : "מה הסכום הכולל כעת? (₪)";
    }
    segD.addEventListener("click", () => setSeg("deposit"));
    segT.addEventListener("click", () => setSeg("total"));

    $("entry-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const amt = parseInt($("amount").value.replace(/[^\d]/g, ""), 10);
      if (!amt && amt !== 0) return;
      const newTotal = entryMode === "deposit" ? currentTotal() + amt : amt;
      entries.push({ date: $("entry-date").value, total: newTotal, ts: Date.now() });
      entries = normalize(entries);
      saveFn(entries);
      $("amount").value = "";
      $("amount").blur();
    });
  }

  /* ---------- חגיגה + קונפטי ---------- */

  function celebrate(threshold) {
    launchConfetti();
    if (mode === "tv") {
      $("celebrate-text").innerHTML = `🎉 כל הכבוד! 🎉<br>עברת את ${fmtILS.format(threshold)}`;
      $("celebrate").classList.remove("hidden");
      setTimeout(() => $("celebrate").classList.add("hidden"), 8000);
    }
  }

  function launchConfetti() {
    const canvas = $("confetti");
    const ctx = canvas.getContext("2d");
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const colors = ["#f5c04e", "#eda100", "#c98500", "#ffffff", "#0ca30c"];
    const parts = Array.from({ length: 180 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.5,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      vy: 2 + Math.random() * 3.5,
      vx: -1.5 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: -0.1 + Math.random() * 0.2,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const t0 = performance.now();
    (function frame(t) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (t - t0 < 7000) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    })(t0);
  }

  /* ---------- שעון, ציטוטים, הגנת מסך ---------- */

  function tickClock() {
    const now = new Date();
    const t = now.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
    const d = fmtDate.format(now);
    $("clock").textContent = t;
    $("date").textContent = d;
    $("privacy-clock").textContent = t;
    $("privacy-date").textContent = d;
  }

  let quoteIdx = -1;
  function tickQuote() {
    if (!QUOTES.length) return;
    const now = new Date();
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / MS_PER_DAY);
    const idx = (dayOfYear * 7 + Math.floor((now.getHours() * 60 + now.getMinutes()) / 5)) % QUOTES.length;
    if (idx === quoteIdx) return;
    const q = $("quote");
    if (quoteIdx === -1) { // טעינה ראשונה — בלי אנימציית מעבר
      quoteIdx = idx;
      q.textContent = QUOTES[idx];
      return;
    }
    quoteIdx = idx;
    q.classList.add("fading");
    setTimeout(() => {
      q.textContent = QUOTES[idx];
      q.classList.remove("fading");
    }, 1200);
  }

  // הזזה איטית של כל המסך — מניעת burn-in בתוכן סטטי
  function tickDrift() {
    const dx = -10 + Math.random() * 20;
    const dy = -8 + Math.random() * 16;
    $("tv-drift").style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /* ---------- עדכון נתונים ---------- */

  function onData(raw) {
    entries = normalize(raw);
    const total = currentTotal();
    if (prevTotal !== null && total > prevTotal) {
      const crossed = crossedMilestone(prevTotal, total);
      if (crossed && !privacyHidden) celebrate(crossed);
    }
    prevTotal = total;
    if (mode === "tv") renderTV();
    else renderEdit();
  }

  /* ---------- אתחול ---------- */

  if (mode === "tv") {
    tickClock();
    setInterval(tickClock, 1000);
    tickQuote();
    setInterval(tickQuote, 30000);
    setInterval(tickDrift, 90000);
    window.addEventListener("resize", drawSpark);

    applyPrivacy = (hidden) => {
      privacyHidden = hidden;
      $("privacy-screen").classList.toggle("hidden", !hidden);
    };
  } else {
    setupEditForm();

    const toggleBtn = $("privacy-toggle");
    const toggleIcon = $("privacy-toggle-icon");
    applyPrivacy = (hidden) => {
      privacyHidden = hidden;
      toggleBtn.classList.toggle("active", hidden);
      toggleBtn.setAttribute("aria-pressed", String(hidden));
      toggleIcon.textContent = hidden ? "🙉" : "🙈";
    };
    toggleBtn.addEventListener("click", () => {
      if (privacyStore) privacyStore.setHidden(!privacyHidden);
    });
  }

  initPrivacyStore().then((store) => { privacyStore = store; });

  // ?demo=1 — נתונים לדוגמה לתצוגה מקדימה (לא נשמרים)
  if (params.get("demo")) {
    saveFn = () => {};
    setSyncState("מצב דמו");
    const demo = [];
    let total = 0;
    const start = new Date();
    start.setMonth(start.getMonth() - 8);
    for (let i = 0; i < 9; i++) {
      total += 28000 + Math.round(Math.random() * 14000);
      const d = new Date(start);
      d.setMonth(d.getMonth() + i);
      demo.push({ date: d.toISOString().slice(0, 10), total, ts: i });
    }
    onData(demo);
  } else if (cfg.firebase && cfg.firebase.apiKey) {
    initFirebaseStore();
  } else {
    // מנסה את ה-API של Vercel; אם אין (הרצה מקומית) — מצב מקומי
    initApiStore();
  }
})();
