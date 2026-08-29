type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean; VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';
const isOrc = env?.VITE_BUILD === 'orc';

export const APP_ID = isOrc
  ? 'com.striblet.emdash.orc'
  : isCanary
    ? 'com.emdash.canary'
    : 'com.emdash.stable';
export const PRODUCT_NAME = isOrc ? 'Emdash Orc' : isCanary ? 'Emdash Canary' : 'Emdash';
export const APP_NAME_LOWER = isOrc ? 'emdash-orc' : isCanary ? 'emdash-canary' : 'emdash';
export const USER_DATA_DIR_NAME = isDev
  ? 'emdash-dev'
  : isOrc
    ? 'emdash-orc'
    : isCanary
      ? 'emdash-canary'
      : 'emdash';
export const UPDATE_CHANNEL = isOrc ? 'orc' : isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isOrc ? 'emdash-orc' : isCanary ? 'emdash-canary' : 'emdash';
export const R2_BASE_URL = 'https://releases.emdash.sh';
export const IS_CANARY = isCanary || isOrc;
