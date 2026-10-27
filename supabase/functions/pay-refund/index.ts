import { defaultDeps } from '../_shared/env.ts'
import { handle } from './handler.ts'

Deno.serve((req) => handle(req, defaultDeps()))
