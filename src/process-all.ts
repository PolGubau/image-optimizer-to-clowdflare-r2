/**
 * process-all.ts
 *
 * Procesa todos los álbumes encontrados en input/ de forma secuencial.
 * Equivale a ejecutar `pnpm process <album>` por cada carpeta.
 *
 * Uso: pnpm process-albums
 */

import { readdir } from "fs/promises";
import { spawnSync } from "child_process";

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

	const failed: string[] = [];

	for (const album of entries) {
		console.log("─".repeat(50));
		const result = spawnSync(
			"npx", ["tsx", "src/process-album.ts", album],
			{ stdio: "inherit", shell: true },
		);
		if (result.status !== 0) {
			console.error(`\n❌  Falló: "${album}"`);
			failed.push(album);
		}
	}

	console.log("\n" + "─".repeat(50));
	if (failed.length === 0) {
		console.log(`✅  ${entries.length}/${entries.length} álbumes procesados`);
	} else {
		console.log(`⚠️   ${entries.length - failed.length}/${entries.length} álbumes procesados`);
		console.error(`❌  Fallaron: ${failed.join(", ")}`);
		process.exit(1);
	}
};

main();
