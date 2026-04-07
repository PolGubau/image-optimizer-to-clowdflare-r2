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
 * Uso: pnpm export-labels <album>
 *      pnpm export-labels granada
 */

import fs from "fs/promises";
import path from "path";
import type { Photo } from "./types.js";

const ALBUM = process.argv[2] ?? "granada";

const main = async () => {
	const albumPath = path.join("./output", ALBUM, "album.json");
	const labelsPath = path.join("./input", ALBUM, "labels.json");

	let photos: Photo[];
	try {
		const raw = await fs.readFile(albumPath, "utf8");
		photos = (JSON.parse(raw) as { photos: Photo[] }).photos;
	} catch {
		console.error(`❌  No se encontró ${albumPath}`);
		console.error(`    Ejecuta primero: pnpm process:new ${ALBUM}`);
		process.exit(1);
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

	console.log(`\n🏷️   Labels exportados → ${labelsPath}`);
	console.log(`   ✓ Auto-generados añadidos: ${added}`);
	console.log(`   ✓ Manuales existentes:     ${manual}`);
	console.log(`   ✓ Total en archivo:        ${total}`);
	console.log(`\nEdita ${labelsPath} y vuelve a ejecutar:`);
	console.log(`   pnpm process:new ${ALBUM}\n`);
};

main();
