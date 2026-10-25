import type { WorldSchema } from '@once-upon/shared';
import world from './demo-world.json' with { type: 'json' };

/** The bundled combat world: one encounter and a boss. A fresh copy per room, since rooms mutate it. */
export function demoWorld(): WorldSchema {
  return structuredClone(world) as unknown as WorldSchema;
}
