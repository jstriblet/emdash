import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.striblet.emdash.orc',
  productName: 'Emdash Orc',
  executableName: 'Emdash Orc',
  directories: { output: 'release' },
  artifactName: 'emdash-orc-${arch}.${ext}',
  publish: [
    {
      provider: 'github',
      owner: 'jstriblet',
      repo: 'emdash',
      releaseType: 'prerelease',
      channel: 'orc',
    },
  ],
  files: ['out/**/*', 'node_modules/**/*', 'drizzle/**/*'],
  asarUnpack: [
    'out/main/adapters/**',
    'node_modules/better-sqlite3/**',
    'node_modules/node-pty/**',
    'node_modules/@parcel/watcher/**',
    '**/*.node',
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Emdash Orc needs microphone access for voice dictation and voice mode features.',
    },
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    icon: 'src/assets/images/emdash/emdash.icns',
    notarize: false,
  },
  dmg: {
    icon: 'src/assets/images/emdash/emdash.icns',
    background: 'build/dmg-background.tiff',
    window: { width: 530, height: 319 },
    contents: [
      { x: 132, y: 150, type: 'file' },
      { x: 398, y: 150, type: 'link', path: '/Applications' },
    ],
  },
  npmRebuild: false,
  electronFuses: { enableCookieEncryption: true },
};

export default config;
