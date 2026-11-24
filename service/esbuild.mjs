import * as fs from "fs";
import * as path from "path";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const outdir = path.resolve(process.env.YAAT_BUILD_OUT_DIR ?? "../dist");

const sessionDir = path.resolve("src/session");
const quotaDir = path.join(sessionDir, "quota");
const extensionFiles = ["acp-readiness.ts", "pi-panel-bridge.ts", "pi-quota.ts", "quota-schema.ts"];

function quotaFiles() {
  return fs.readdirSync(quotaDir).filter((file) => file.endsWith(".ts"));
}

function copyPiExtensions() {
  const quota = quotaFiles();
  const outQuota = path.join(outdir, "quota");
  fs.mkdirSync(outQuota, { recursive: true });
  for (const file of [...extensionFiles, ...quota.map((file) => path.join("quota", file))]) {
    const target = path.join(outdir, file);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(path.join(sessionDir, file), tmp);
      fs.renameSync(tmp, target);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  for (const file of fs.readdirSync(outQuota)) {
    if (file.endsWith(".ts") && !quota.includes(file)) fs.rmSync(path.join(outQuota, file));
  }
}

const entry = path.resolve("src/index.ts");
const copyExtensions = {
  name: "publish-pi-extensions",
  setup(build) {
    // Pi (not the server bundle) loads these files. Add them to esbuild's
    // watch graph, including directory membership so removed files disappear.
    if (watch)
      build.onLoad({ filter: /[\\/]index\.ts$/ }, ({ path: file }) => {
        if (file !== entry) return;
        return {
          contents: fs.readFileSync(file, "utf8"),
          loader: "ts",
          resolveDir: path.dirname(file),
          watchDirs: [quotaDir],
          watchFiles: [
            file,
            ...extensionFiles.map((name) => path.join(sessionDir, name)),
            ...quotaFiles().map((name) => path.join(quotaDir, name)),
          ],
        };
      });
    build.onEnd(({ errors }) => {
      if (!errors.length) copyPiExtensions();
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const build = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node26",
  sourcemap: true,
  minify: false,
  // The search index runs in a worker thread of its own (history-service.ts).
  entryPoints: {
    server: "src/index.ts",
    "history-worker": "src/workspace/history-worker.ts",
  },
  outdir,
  plugins: [copyExtensions],
};

if (watch) {
  esbuild.context(build).then((ctx) => {
    ctx.watch();
    console.log("Watching for changes...");
  });
} else {
  esbuild.build(build).then(() => {
    console.log("Server built.");
  });
}
