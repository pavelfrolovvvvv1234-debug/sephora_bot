/**
 * Runs the same dist alias rewrite as fix-dist-aliases.cjs.
 * Kept for `build` script (`fix-dist-aliases || fix-dist-fallback`) so CI/VPS
 * always rewrites @entities/* etc. if the primary script is missing.
 */
require("./fix-dist-aliases.cjs");
