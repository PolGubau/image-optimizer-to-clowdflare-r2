/**
 * export-labels.ts
 *
 * Exporta los labels auto-generados al archivo input/<album>/labels.json
 * para que puedas revisarlos y editarlos a mano antes de publicar.
 *
 * - Los labels manuales existentes NO se sobreescriben.
 * - Solo añade los auto-generados que aún no estén en el archivo.
 * - Tras editar, vuelve a ejecutar pnpm process:new <album>.
 *
 * Uso:
 *   pnpm export-labels <album>       — un álbum concreto
 *   pnpm export-labels:all           — todos los álbumes de output/
 */

import fs from "fs/promises";
import path from "path";
import type { Photo } from "./types.js";

const exportAlbum = async (album: string): Promise<void> => {
	const albumPath = path.join("./output", album, "album.json");
	const labelsPath = path.join("./input", album, "labels.json");

	let photos: Photo[];
	try {
		const raw = await fs.readFile(albumPath, "utf8");
		photos = (JSON.parse(raw) as { photos: Photo[] }).photos;
	} catch {
		console.error(`❌  No se encontró ${albumPath}`);
		console.error(`    Ejecuta primero: pnpm process:new ${album}`);
		return;
	}

	// Labels manuales existentes — tienen prioridad
	let existing: Record<string, string> = {};
	try {
		const raw = await fs.readFile(labelsPath, "utf8");
		existing = JSON.parse(raw) as Record<string, string>;
	} catch { /* no existe aún, empezamos desde cero */ }

	let added = 0;
	const result: Record<string, string> = { ...existing };

	for (const photo of photos) {
		if (!photo.label) continue;
		if (existing[photo.filename]) continue; // no sobreescribir manuales
		result[photo.filename] = photo.label;
		added++;
	}

	await fs.writeFile(labelsPath, JSON.stringify(result, null, 2));

	const total = Object.keys(result).length;
	const manual = total - added;

	console.log(`\n🏷️   [${album}] Labels exportados → ${labelsPath}`);
	console.log(`   ✓ Auto-generados añadidos: ${added}`);
	console.log(`   ✓ Manuales existentes:     ${manual}`);
	console.log(`   ✓ Total en archivo:        ${total}`);
};

const main = async () => {
	const isAll = process.argv.includes("--all");

	if (isAll) {
		// Leer todos los álbumes disponibles en output/
		let entries: string[];
		try {
			entries = (await fs.readdir("./output", { withFileTypes: true }))
				.filter((e) => e.isDirectory() && e.name !== ".")
				.map((e) => e.name);
		} catch {
			console.error("❌  No se encontró la carpeta output/");
			process.exit(1);
		}

		if (entries.length === 0) {
			console.error("❌  No hay álbumes procesados en output/");
			process.exit(1);
		}

		console.log(`📂  Exportando labels de ${entries.length} álbumes...\n`);
		for (const album of entries) {
			await exportAlbum(album);
		}
		console.log(`\nEdita los labels.json y vuelve a ejecutar:\n   pnpm process:json <album> --json-only\n`);
	} else {
		const album = process.argv[2];
		if (!album) {
			console.error("❌  Especifica un álbum: pnpm export-labels <album>");
			console.error("    O usa: pnpm export-labels:all");
			process.exit(1);
		}
		await exportAlbum(album);
		console.log(`\nEdita ${path.join("input", album, "labels.json")} y vuelve a ejecutar:`);
		console.log(`   pnpm process:json ${album} --json-only\n`);
	}
};

main().catch((err: Error) => { console.error(`❌  ${err.message}`); process.exit(1); });
