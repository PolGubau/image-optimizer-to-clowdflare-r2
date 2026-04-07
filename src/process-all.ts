/**
 * process-all.ts
 *
 * Procesa todos los álbumes encontrados en input/ de forma secuencial.
 * Equivale a ejecutar `pnpm process <album>` por cada carpeta.
 *
 * Uso: pnpm process-albums
 */

import {readdir} from "fs/promises";
import { execSync } from "child_process";

const main = async () => {
	let entries: string[] = [];
	try {
		const dirs = await readdir("./input", { withFileTypes: true });
		entries = dirs.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		console.error("❌  No existe input/ con álbumes");
		process.exit(1);
	}

	if (entries.length === 0) {
		console.error("❌  No hay carpetas en input/");
		process.exit(1);
	}

	console.log(`🗂️  ${entries.length} álbumes encontrados: ${entries.join(", ")}\n`);

	for (const album of entries) {
		console.log("─".repeat(50));
		execSync(`npx tsx src/process-album.ts ${album}`, { stdio: "inherit" });
	}

	console.log("\n" + "─".repeat(50));
	console.log(`✅  Todos los álbumes procesados`);
};

main();
