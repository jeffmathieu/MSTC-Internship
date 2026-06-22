const fs = require("fs");
const path = require("path");

const testDir = __dirname;

// Simple zero-dependency test runner. It executes every *.test.js file in a
// stable order, so adding a new test file only requires naming it with that
// suffix and using Node's built-in assert module.
const testFiles = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith(".test.js"))
  .sort();

for (const file of testFiles) {
  console.log(`\nRunning ${file}`);
  require(path.join(testDir, file));
}
