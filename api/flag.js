// GET  /api/flag?id=XXX  → { hidden, until }
// POST /api/flag?id=XXX  → { hidden: true|false }  (גוף הבקשה)
// "מצב אורחים": כשמישהו בחדר, מהטלפון מסתירים את המסך לזמן קצוב.
// אותו אחסון (Upstash Redis) כמו api/data.js, במפתח נפרד.

const AUTO_REVERT_MS = 3 * 60 * 60 * 1000; // 3 שעות — רשת ביטחון אם שוכחים להחזיר

module.exports = async (req, res) => {
  const base =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!base || !token) {
    return res.status(503).json({ error: "storage-not-configured" });
  }

  const id = String(req.query.id || "").replace(/[^\w-]/g, "");
  if (!id || id.length < 8) {
    return res.status(400).json({ error: "missing-or-short-id" });
  }
  const key = "privacy:" + id;
  const auth = { Authorization: "Bearer " + token };

  if (req.method === "GET") {
    const r = await fetch(`${base}/get/${key}`, { headers: auth });
    const j = await r.json();
    const state = j.result ? JSON.parse(j.result) : { hidden: false, until: null };
    if (state.hidden && state.until && Date.now() > state.until) {
      state.hidden = false;
      state.until = null;
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(state);
  }

  if (req.method === "POST") {
    const hidden = !!(req.body && req.body.hidden);
    const state = { hidden, until: hidden ? Date.now() + AUTO_REVERT_MS : null };
    const r = await fetch(`${base}/set/${key}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(state),
    });
    if (!r.ok) return res.status(502).json({ error: "storage-write-failed" });
    return res.status(200).json(state);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "method-not-allowed" });
};
