const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT = LEVELS[process.env.LOG_LEVEL || "info"] ?? 1;

function fmt(level, mod, msg, meta) {
  const base = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${mod}] ${msg}`;
  return meta ? `${base} ${JSON.stringify(meta)}` : base;
}

export function createLogger(mod) {
  return {
    debug: (m, x) => { if (CURRENT <= 0) console.debug(fmt("debug", mod, m, x)); },
    info:  (m, x) => { if (CURRENT <= 1) console.log(fmt("info",  mod, m, x)); },
    warn:  (m, x) => { if (CURRENT <= 2) console.warn(fmt("warn",  mod, m, x)); },
    error: (m, x) => { if (CURRENT <= 3) console.error(fmt("error",mod, m, x)); },
  };
}
