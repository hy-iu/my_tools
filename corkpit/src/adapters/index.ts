import type { Adapter } from './types.js';
import { codexAdapter } from './codex.js';
import { claudeCodeAdapter } from './claude-code.js';
import { piAdapter } from './pi.js';
import { opencodeAdapter } from './opencode.js';
import { dshAdapter } from './dsh.js';
import { antigravityAdapter } from './antigravity.js';
import { ccSwitchAdapter } from './cc-switch.js';

export const adapters: Adapter[] = [
  codexAdapter,
  claudeCodeAdapter,
  piAdapter,
  opencodeAdapter,
  dshAdapter,
  antigravityAdapter,
  ccSwitchAdapter,
];

export function getAdapter(id: string): Adapter | undefined {
  return adapters.find((a) => a.id === id);
}

export * from './types.js';
