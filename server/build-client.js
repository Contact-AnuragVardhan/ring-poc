const esbuild = require("esbuild");

esbuild.buildSync({
  entryPoints: ["./public/client.js", "./public/ingest-client.js"],
  bundle: true,
  outdir: "./public",
  entryNames: "[name]-bundle",
  platform: "browser",
  target: ["es2020"],
  format: "iife",
  sourcemap: false,
});

console.log("Built public/*-bundle.js");