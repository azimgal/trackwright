import { initConfig, isInitialized } from '../../config/loader.js';

export interface InitOptions {
  prefix: string;
}

export async function runInit(projectRoot: string, options: InitOptions): Promise<string> {
  const alreadyInitialized = isInitialized(projectRoot);
  const config = await initConfig(projectRoot, options.prefix);
  return alreadyInitialized
    ? `Already initialized (.trackwright/config.yaml exists) — left it untouched. Ticket prefix: ${config.ticketPrefix}`
    : `Initialized .trackwright/config.yaml with ticket prefix "${config.ticketPrefix}".`;
}
