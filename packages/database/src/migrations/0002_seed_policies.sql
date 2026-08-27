-- 0002_seed_policies.sql
-- A handful of realistic starter policies so the gateway is useful out of the box.

INSERT INTO policies (name, route, method, "limit", window_seconds, strategy, identity_types, enabled)
VALUES
  ('login-protection', '/login', 'POST', 5, 60, 'sliding-window', ARRAY['ip'], true),
  ('public-api', '/api/*', '*', 100, 60, 'token-bucket', ARRAY['ip', 'api-key'], true),
  ('default-catch-all', '/*', '*', 300, 60, 'fixed-window', ARRAY['ip'], true)
ON CONFLICT (name) DO NOTHING;
