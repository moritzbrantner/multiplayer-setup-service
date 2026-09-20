import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const sourceDir = join(root, "web");
const outputDir = join(root, "dist", "web");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const sourceNames = (await readdir(sourceDir))
  .filter((name) => name.endsWith(".ts"))
  .sort();

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

for (const name of sourceNames) {
  const outputPath = join(outputDir, name.replace(/\.ts$/, ".js"));
  const emitted = transpiler.transformSync(await readFile(join(sourceDir, name), "utf8"));
  await writeFile(
    outputPath,
    emitted.replaceAll(".ts\"", ".js\"").replaceAll(".ts'", ".js'"),
  );
}

for (const name of (await readdir(sourceDir)).sort()) {
  if (name.endsWith(".html")) {
    const html = await readFile(join(sourceDir, name), "utf8");
    await writeFile(
      join(outputDir, name),
      html.replaceAll(".ts\"", ".js\"").replaceAll(".ts'", ".js'"),
    );
  } else if (name.endsWith(".css") || name === ".nojekyll") {
    await copyFile(join(sourceDir, name), join(outputDir, name));
  }
}
