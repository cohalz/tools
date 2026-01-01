#!/usr/bin/env -S deno run

function main() {
  console.log("Hello, Deno!");
}

if (import.meta.main) {
  main();
}
