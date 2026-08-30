import type { Adapter } from './types.js';
import { codexAdapter } from './codex.js';
import { claudeCodeAdapter } from './claude-code.js';
import { piAdapter } from './pi.js';
import { opencodeAdapter } from './opencode.js';
import { dshAdapter } from './dsh.js';
import { antigravityAdapter } from './antigravity.js';
import { ccSwitchAdapter } from './cc-switch.js';
import { qoderAdapter, qoderCnAdapter } from './qoder.js';

export const adapters: Adapter[] = [
  codexAdapter,
  claudeCodeAdapter,
  piAdapter,
  opencodeAdapter,
  dshAdapter,
  antigravityAdapter,
  ccSwitchAdapter,
  qoderAdapter,
  qoderCnAdapter,
];

export function getAdapter(id: string): Adapter | undefined {
  return adapters.find((a) => a.id === id);
}

export * from './types.js';
