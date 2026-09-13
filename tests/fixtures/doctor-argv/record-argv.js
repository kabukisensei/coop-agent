const fs = require("fs");
const target = process.env.ARGV_RECORD_FILE;
if (target) {
  fs.writeFileSync(target, JSON.stringify(process.argv.slice(2)));
}
console.log("1.0.0");
