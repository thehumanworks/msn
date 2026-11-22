// The API layer is shared with apps/ios (its src/core and src/hooks are platform-independent and tested
// there). Metro watches that folder, and every bare import from it resolves from this app's
// node_modules, so `expo/fetch` is this app's SDK, never apps/ios's.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const sharedCore = path.resolve(__dirname, "../ios/src");
config.watchFolders = [...(config.watchFolders ?? []), sharedCore];

const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const bare = !moduleName.startsWith(".") && !path.isAbsolute(moduleName);
  const fromShared = context.originModulePath.startsWith(sharedCore + path.sep);
  const next =
    bare && fromShared ? { ...context, originModulePath: path.join(__dirname, "package.json") } : context;
  return (resolveRequest ?? context.resolveRequest)(next, moduleName, platform);
};

module.exports = config;
