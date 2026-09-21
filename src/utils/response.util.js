export function ok(res, data = null, message = "OK", status = 200) {
  const body = { success: true };
  if (message) body.message = message;
  if (data !== null) body.data = data;
  return res.status(status).json(body);
}

export function fail(res, code, message, status = 400, meta = undefined) {
  const error = { code, message, ...meta };
  return res.status(status).json({ success: false, error });
}

export function serverError(res, err, context = "") {
  const label = context ? `[${context}] ` : "";
  console.error(`❌ ${label}${err.stack || err.message}`);
  return res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
  });
}

export function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
