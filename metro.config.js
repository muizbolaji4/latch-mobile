// // Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
// const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'crypto') {
    // when importing crypto, resolve to react-native-quick-crypto
    return context.resolveRequest(context, 'react-native-quick-crypto', platform);
  }
  // otherwise chain to the standard Metro resolver.
  return context.resolveRequest(context, moduleName, platform);
};

// Extend Metro's defaults rather than replacing them — a bare object here drops
// output.ascii_only/quote_style/wrap_iife and mangle.toplevel, which the Hermes
// production bundle depends on and which have no effect in dev, so anything they
// break only ever shows up in a release build.
config.transformer.minifierConfig = {
  ...config.transformer.minifierConfig,
  compress: {
    ...config.transformer.minifierConfig?.compress,
    drop_console: true, // removes console.log in production
  },
};

module.exports = config;
