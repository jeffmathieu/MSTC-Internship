const fs = require("fs");
const path = require("path");

const testDir = __dirname;

const testFiles = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith(".test.js"))
  .sort();

for (const file of testFiles) {
  console.log(`\nRunning ${file}`);
  require(path.join(testDir, file));
}