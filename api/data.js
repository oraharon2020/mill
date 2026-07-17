// GET  /api/data?id=XXX  → רשימת העדכונים
// POST /api/data?id=XXX  → שמירת הרשימה (גוף הבקשה: JSON)
// האחסון: Upstash Redis שמחובר לפרויקט ב-Vercel (Storage → Upstash for Redis).
// ההתחברות דרך משתני הסביבה שה-integration מזריק אוטומטית.

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
  const key = "savings:" + id;
  const auth = { Authorization: "Bearer " + token };

  if (req.method === "GET") {
    const r = await fetch(`${base}/get/${key}`, { headers: auth });
    const j = await r.json();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(j.result ? JSON.parse(j.result) : []);
  }

  if (req.method === "POST") {
    const list = Array.isArray(req.body) ? req.body : [];
    const r = await fetch(`${base}/set/${key}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(list),
    });
    if (!r.ok) return res.status(502).json({ error: "storage-write-failed" });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "method-not-allowed" });
};
