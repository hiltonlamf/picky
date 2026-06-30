// Side-effecting module: loads .env.local before any lib module is evaluated.
// Must be the FIRST import in a script (ESM evaluates imports in order, so this
// runs before lib/ai.ts constructs its Anthropic client from process.env).
import { config } from 'dotenv';
// override: the shell may export empty values (e.g. ANTHROPIC_API_KEY=) that
// would otherwise shadow the real values in .env.local.
config({ path: '.env.local', override: true });
