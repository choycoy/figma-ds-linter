import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const dist = path.join(__dirname, "dist");
fs.mkdirSync(dist, { recursive: true });

const htmlTemplate = fs.readFileSync(
  path.join(__dirname, "src/ui/ui.html"),
  "utf8"
);

/** Bundle the React UI into outputFiles (js + css) and inline them into one HTML file. */
function inlineUiPlugin() {
  return {
    name: "inline-ui-html",
    setup(build) {
      build.onEnd((result) => {
        const files = result.outputFiles || [];
        const js = files.find((f) => f.path.endsWith(".js"));
        const css = files.find((f) => f.path.endsWith(".css"));
        if (!js) return;

        let html = htmlTemplate;
        if (css) {
          html = html.replace(
            "</head>",
            `  <style>${css.text}</style>\n  </head>`
          );
        }
        html = html.replace("<!-- BUNDLE -->", `<script>${js.text}</script>`);
        fs.writeFileSync(path.join(dist, "ui.html"), html);
        console.log(`[ds-linter] built ui.html (${(html.length / 1024).toFixed(1)} kb)`);
      });
    },
  };
}

const common = {
  bundle: true,
  minify: !watch,
  logLevel: "info",
};

const codeCtx = await esbuild.context({
  ...common,
  entryPoints: [path.join(__dirname, "src/code.ts")],
  outfile: path.join(dist, "code.js"),
  // Figma's plugin sandbox parser rejects some modern syntax (e.g. optional
  // catch binding `catch {}`), so down-level the main-thread bundle.
  target: "es2017",
});

const uiCtx = await esbuild.context({
  ...common,
  entryPoints: [path.join(__dirname, "src/ui/ui.tsx")],
  outdir: dist, // produces ui.js (+ ui.css), consumed in-memory by the plugin
  write: false,
  target: "es2017",
  jsx: "automatic",
  loader: { ".css": "css" },
  plugins: [inlineUiPlugin()],
});

if (watch) {
  await Promise.all([codeCtx.watch(), uiCtx.watch()]);
  console.log("[ds-linter] watching for changes…");
} else {
  await Promise.all([codeCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([codeCtx.dispose(), uiCtx.dispose()]);
  console.log("[ds-linter] build complete → dist/");
}
