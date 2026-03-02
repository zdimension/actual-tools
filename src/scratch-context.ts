import * as api from '@actual-app/api';
import { utils } from '@actual-app/api';
import { ConfigManager } from './config-manager.js';
import { ActualClient } from './actual-client.js';
import { RootConfig } from './types.js';

export interface ScratchContext {
  actualClient: ActualClient;
  config: RootConfig;
  configManager: ConfigManager;
  args: string[];
  api: typeof api;
  utils: typeof utils;
  cwd: string;
}

export type ScratchScriptRunner = (ctx: ScratchContext) => Promise<void> | void;

export interface ScratchScriptModule {
  default?: ScratchScriptRunner;
  run?: ScratchScriptRunner;
}

export function getScratchContext(): ScratchContext {
  const context = (globalThis as any).__ACTUAL_TOOLS_CONTEXT__ as ScratchContext | undefined;

  if (!context) {
    throw new Error(
      'Scratch context is not available. Run this file via: npm start -- <path-to-script.js>'
    );
  }

  return context;
}
