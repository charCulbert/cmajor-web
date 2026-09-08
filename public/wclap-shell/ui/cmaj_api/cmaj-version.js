// Stands in for the server-provided /cmaj_api/cmaj-version.js of a hosted patch.
import { compilerVersion } from '../compiler-info.js';
export function getCmajorVersion() { return compilerVersion; }
