// Delete dist directory
import { rm, cp, mkdir, exists } from "fs/promises";

if (!(await exists("./pages/dist"))) {
	console.log("Please build the Vite server first, or use `bun prod-build`");
	process.exit(1);
}

console.log(`Building at ${process.cwd()}`);

await rm("./dist", { recursive: true });

await mkdir(process.cwd() + "/dist");

await Bun.build({
	entrypoints: [
		process.cwd() + "/index.ts",
		process.cwd() + "/prisma.ts",
		process.cwd() + "./cli.ts",
	],
	outdir: process.cwd() + "/dist",
	target: "bun",
	splitting: true,
	minify: true,
	external: ["bullmq", "@prisma/client"],
});

// Create pages directory
await mkdir(process.cwd() + "/dist/pages");

// Copy Vite build output to dist
await cp(process.cwd() + "/pages/dist", process.cwd() + "/dist/pages/", {
	recursive: true,
});

console.log(`Built!`);
