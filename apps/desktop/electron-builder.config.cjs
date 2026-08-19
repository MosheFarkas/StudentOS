/**
 * Packaging config.
 *
 * A JavaScript config rather than a block in package.json for one reason:
 * notarization has to be conditional. Setting `notarize: true` unconditionally
 * fails the build on any machine without Apple credentials -- including CI,
 * and including a contributor who just wants to check the app still launches.
 * Here it switches itself on only when the credentials actually exist.
 */

// App Store Connect API key (preferred), or the older Apple ID + app-specific
// password. Either set is enough; electron-builder reads them from the
// environment itself, so nothing secret is ever written into this file.
const hasApiKey = Boolean(
  process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER,
);
const hasAppleId = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID,
);
const canNotarize = hasApiKey || hasAppleId;

if (!canNotarize) {
  console.log(
    '[desktop] No Apple credentials — building unsigned.\n' +
      '[desktop] Runs here. On any other Mac the student must approve it once in\n' +
      '[desktop] System Settings > Privacy & Security. See README, "Installing it".',
  );
}

module.exports = {
  appId: 'ai.contextoagent.desktop',
  productName: 'ContextoAgent',
  directories: { output: 'release', buildResources: 'build' },
  // Ship source only. The Chrome this drives is the student's own install,
  // not a bundled copy, which keeps the download to Electron alone.
  files: ['src/**/*', '!src/**/*.test.mjs', 'package.json'],
  mac: {
    category: 'public.app-category.education',
    // Apple Silicon only for now. Adding 'x64' back builds an Intel DMG too,
    // at the cost of a second ~110MB download and a second unpacked app that
    // is easy to launch by mistake -- they are indistinguishable in Spotlight.
    target: [{ target: 'dmg', arch: ['arm64'] }],
    // The hardened runtime exists to satisfy notarization, and it constrains
    // what V8 may do. Enabling it on a build that is not being notarized adds
    // the constraints and buys nothing.
    hardenedRuntime: canNotarize,
    ...(canNotarize
      ? {
          entitlements: 'build/entitlements.mac.plist',
          entitlementsInherit: 'build/entitlements.mac.plist',
        }
      : {}),
    notarize: canNotarize,
  },
};
