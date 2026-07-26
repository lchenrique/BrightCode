const { rebuild } = require("@electron/rebuild");

const architectureNames = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
};

module.exports = async function beforePack(context) {
  const arch = architectureNames[context.arch];
  if (!arch) {
    throw new Error(`Unsupported Electron build architecture: ${context.arch}`);
  }

  await rebuild({
    buildPath: context.packager.info.appDir,
    electronVersion: context.packager.info.framework.version,
    platform: context.electronPlatformName,
    arch,
    onlyModules: ["keytar"],
    force: true,
    mode: "sequential",
  });
};
