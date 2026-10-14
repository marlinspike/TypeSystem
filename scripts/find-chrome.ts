import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * A Chromium for the browser tests and measurements: `CHROME_PATH`,
 * Playwright's (`/opt/pw-browsers`), or the system's (GitHub's runners have
 * Chrome). Undefined when there is none, so callers can skip.
 */
export function findChrome(): string | undefined {
  const pw = "/opt/pw-browsers";
  const candidates = [
    process.env.CHROME_PATH,
    ...(existsSync(pw) ? readdirSync(pw).filter((d) => d.startsWith("chromium-")).map((d) => path.join(pw, d, "chrome-linux/chrome")) : []),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  return candidates.find((c): c is string => typeof c === "string" && existsSync(c));
}
