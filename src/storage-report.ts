/**
 * storage-report.ts
 *
 * Muestra cuánto ocupa cada álbum en output/ y el total
 * frente al free tier de 10 GB de Cloudflare R2.
 *
 * Uso: pnpm storage
 */

import fs from "fs/promises";
import path from "path";

const FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

const getDirSize = async (dir: string): Promise<number> => {
	let total = 0;
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) total += await getDirSize(full);
		else total += (await fs.stat(full)).size;
	}
	return total;
};

const fmt = (bytes: number): string => {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const progressBar = (used: number, total: number, width = 32): string => {
	const pct = Math.min(used / total, 1);
	const filled = Math.round(pct * width);
	const color = pct > 0.8 ? "🔴" : pct > 0.5 ? "🟡" : "🟢";
	return `${color} [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${(pct * 100).toFixed(1)}%`;
};

const main = async () => {
	let entries: string[] = [];
	try {
		entries = await fs.readdir("./output");
	} catch {
		console.error("❌  No existe output/ — ejecuta pnpm process primero");
		process.exit(1);
	}

	const albums: { name: string; bytes: number }[] = [];
	let totalBytes = 0;

	for (const entry of entries) {
		const dir = path.join("./output", entry);
		if (!(await fs.stat(dir)).isDirectory()) continue;
		const bytes = await getDirSize(dir);
		albums.push({ name: entry, bytes });
		totalBytes += bytes;
	}

	albums.sort((a, b) => b.bytes - a.bytes);

	console.log("\n📊  Storage Report — output/\n");
	console.log("  Álbum                    Tamaño");
	console.log("  " + "─".repeat(36));

	for (const album of albums) {
		const name = album.name.padEnd(24);
		console.log(`  ${name} ${fmt(album.bytes)}`);
	}

	console.log("  " + "─".repeat(36));
	console.log(`  ${"TOTAL".padEnd(24)} ${fmt(totalBytes)}`);
	console.log(`\n  Free tier R2: ${FREE_TIER_BYTES / (1024 ** 3)} GB`);
	console.log(`  ${progressBar(totalBytes, FREE_TIER_BYTES)}`);
	console.log(`\n  Disponible: ${fmt(FREE_TIER_BYTES - totalBytes)}\n`);
};

main();
