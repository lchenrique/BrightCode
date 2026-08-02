const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const { rcedit } = await import("rcedit");
  const executablePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  const iconPath = path.join(context.packager.projectDir, "build", "icon.ico");

  await rcedit(executablePath, {
    icon: iconPath,
    'file-version': context.packager.appInfo.version,
    'product-version': context.packager.appInfo.version,
    'version-string': {
      ProductName: context.packager.appInfo.productName,
      FileDescription: context.packager.appInfo.description,
      InternalName: context.packager.appInfo.productFilename,
      OriginalFilename: `${context.packager.appInfo.productFilename}.exe`,
    },
  });
};
