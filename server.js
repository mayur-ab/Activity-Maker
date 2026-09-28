const path = require("path");
const express = require("express");
const { loadEnv } = require("./lib/env");
const { getCatalog } = require("./lib/db");
const { generateActivities } = require("./lib/generate");

loadEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, writes: false });
});

app.get("/api/catalog", async (_req, res) => {
  try {
    const catalog = await getCatalog();
    res.json({
      ...catalog,
      hasServerKey: Boolean(process.env.OPENROUTER_API_KEY),
      model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const result = await generateActivities(req.body || {});
    res.json(result);
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "OpenRouter took too long. Try again."
      : error.message;
    res.status(400).json({ error: message });
  }
});

const port = Number(process.env.PORT) || 3847;
app.listen(port, () => {
  console.log(`Activity Maker listening on http://localhost:${port}`);
});
