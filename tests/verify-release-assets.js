const fs = require('fs');
const path = require('path');

// electron-updater downloads every file named by latest.yml/latest-mac.yml.
// GitHub normalizes spaces in uploaded asset names, so verify exact filenames
// before publishing rather than discovering a 404 from an installed app.
function verifyReleaseAssets(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error(`Updater manifest not found: ${manifestPath || '(missing path)'}`);
  }
  const yaml = fs.readFileSync(manifestPath, 'utf8');
  const urls = [...yaml.matchAll(/^\s*-?\s*url:\s*(.+?)\s*$/gm)]
    .map((match) => match[1].replace(/^['"]|['"]$/g, ''));
  if (!urls.length) throw new Error(`No update asset URLs found in ${manifestPath}`);

  const folder = path.dirname(manifestPath);
  const missing = urls.filter((url) => {
    const filename = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop());
    return !fs.existsSync(path.join(folder, filename));
  });
  if (missing.length) {
    throw new Error(`Updater manifest references missing release assets: ${missing.join(', ')}`);
  }
  return urls;
}

if (require.main === module) {
  const urls = verifyReleaseAssets(process.argv[2]);
  console.log(`Verified ${urls.length} updater asset(s).`);
}

module.exports = { verifyReleaseAssets };
