import { fileURLToPath } from "node:url";

/** Where `npm run build` puts the two bundled clients: `composed/` and `handwritten/`. */
export const MISSION_CLIENT_DIR = fileURLToPath(new URL("../dist/public", import.meta.url));
