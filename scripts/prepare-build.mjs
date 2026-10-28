import fs from "node:fs";
import path from "node:path";

// A normal, potentially partial build is no longer the previously sealed
// artifact. Release preparation writes fresh identity only after validation.
fs.rmSync(path.join(process.cwd(), "dist", "build-info.json"), { force: true });
