// The one server-side piece: forwards a request to TypeSafe with the visitor's own key.
// api.typesafe.ai does not allow browser origins, so the page cannot call it directly.
// The key travels in a header for this request only; nothing is stored or logged.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = req.headers["x-typesafe-key"];
  if (!key) return res.status(401).json({ error: "Missing x-typesafe-key header" });
  const started = Date.now();
  const upstream = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(req.body),
  });
  const text = await upstream.text();
  res.setHeader("x-upstream-ms", String(Date.now() - started));
  res.status(upstream.status).setHeader("content-type", "application/json").send(text);
}
