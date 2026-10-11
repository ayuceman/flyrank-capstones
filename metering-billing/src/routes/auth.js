import { findTenantByApiKey } from "../services/tenants.js";

// X-API-Key -> req.tenant. 401 otherwise. Every tenant route goes through this.
export async function requireTenant(req, res, next) {
  try {
    const tenant = await findTenantByApiKey(req.get("x-api-key"));
    if (!tenant) return res.status(401).json({ error: "unauthorized", message: "Missing or invalid X-API-Key header." });
    req.tenant = tenant;
    next();
  } catch (e) { next(e); }
}

export function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.get("x-admin-key") !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "unauthorized", message: "Missing or invalid X-Admin-Key header." });
  }
  next();
}
