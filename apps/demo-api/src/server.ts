import express from "express";
import { loadConfig } from "@sentinel/config";
import { createLogger } from "@sentinel/logger";

const config = loadConfig();
const logger = createLogger({ name: "demo-api" });

const app = express();
app.use(express.json());

app.use((req, _res, next) => {
  logger.debug({ method: req.method, path: req.path }, "demo-api request");
  next();
});

app.get("/products", (_req, res) => {
  res.json({
    products: [
      { id: 1, name: "Wireless Mouse", price: 799 },
      { id: 2, name: "Mechanical Keyboard", price: 3499 },
      { id: 3, name: "USB-C Hub", price: 1299 },
    ],
  });
});

app.get("/api/users", (_req, res) => {
  res.json({ users: [{ id: 1, name: "Asha" }, { id: 2, name: "Rohit" }] });
});

app.get("/api/orders", (_req, res) => {
  res.json({ orders: [{ id: "ORD-1001", status: "shipped" }] });
});

// Deliberately "sensitive-looking" endpoints so the endpoint-scanning demo scenario has
// something realistic to probe (a real scanner targets things like this).
app.get("/api/admin", (_req, res) => {
  res.status(403).json({ error: "FORBIDDEN", message: "Admin endpoint requires elevated access" });
});
app.get("/api/config", (_req, res) => {
  res.status(403).json({ error: "FORBIDDEN", message: "Config endpoint requires elevated access" });
});
app.get("/api/debug", (_req, res) => {
  res.status(403).json({ error: "FORBIDDEN", message: "Debug endpoint requires elevated access" });
});

// Fixed demo credentials — this is a toy backend, not the admin auth system.
app.post("/login", (req, res) => {
  const { username, password } = req.body ?? {};
  if (username === "demo" && password === "demo1234") {
    res.json({ token: "demo-session-token", user: { username: "demo" } });
  } else {
    res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Invalid username or password" });
  }
});

app.get("/slow", async (_req, res) => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  res.json({ message: "That took a while." });
});

app.get("/error", (_req, res) => {
  res.status(500).json({ error: "INTERNAL_ERROR", message: "This endpoint always fails (for testing)" });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(config.DEMO_API_PORT, () => {
  logger.info({ port: config.DEMO_API_PORT }, "demo-api listening");
});
