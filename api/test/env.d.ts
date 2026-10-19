import type { D1Migration } from 'cloudflare:test';
import type { Env } from '../src/types';

declare global {
  namespace Cloudflare {
    interface Env extends ProvidedEnv {}
  }
}
interface ProvidedEnv extends Env {
  TEST_MIGRATIONS: D1Migration[];
}
