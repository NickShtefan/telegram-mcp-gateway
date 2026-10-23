#!/usr/bin/env node
/**
 * `tg-mcp` entry point. Redirect console.log to stderr first, then
 * import the remaining code and teleproto: any third-party stdout
 * line in stdio mode breaks JSON-RPC.
 */
import { redirectConsoleToStderr } from '../core/log.js';

redirectConsoleToStderr();
// Database, key, and lock socket are accessible only to the gateway user.
// Agent exports/images receive explicit permissions when written.
process.umask(0o077);

const { main } = await import('./main.js');
const code = await main(process.argv.slice(2));
process.exitCode = code;
// The daemon retains a housekeeping timer: exit immediately after shutdown.
if (process.argv[2] === 'serve') process.exit(code);
