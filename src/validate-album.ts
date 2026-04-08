/**
 * validate-album.ts
 *
 * Verifica que todos los archivos referenciados en album.json
 * existen en output/<album>/ antes de subir a Cloudflare R2.
 *
 * Uso:
 *   tsx src/validate-album.ts <album>
 *   tsx src/validate-album.ts granada
 */

import fs from "fs/promises";
import path from "path";
import type { Album } from "./types.js";

const ALBUM = process.argv[2] ?? "granada";
const OUTPUT_DIR = `./output/${ALBUM}`;

const main = async () => {
	const jsonPath = path.join(OUTPUT_DIR, "album.json");

	let album: Album;
	try {
		const raw = await fs.readFile(jsonPath, "utf8");
		album = JSON.parse(raw) as Album;
	} catch {
		console.error(`❌  No se encontró ${jsonPath} — ejecuta primero pnpm process`);
		process.exit(1);
	}

	console.log(`🔍  Validando álbum "${album.id}" (${album.count} fotos)\n`);

	const errors: string[] = [];
	const warnings: string[] = [];

	// 1. count vs photos.length
	if (album.count !== album.photos.length) {
		errors.push(`  ✗  count=${album.count} pero hay ${album.photos.length} fotos en el array`);
	}

	// 2. Archivos de imagen referenciados
	const checkedPaths = new Set<string>();
	for (const photo of album.photos) {
		for (const sizePath of Object.values(photo.sizes)) {
			if (checkedPaths.has(sizePath)) continue; // tamaños reutilizados (foto pequeña)
			checkedPaths.add(sizePath);
			// sizePath puede ser URL absoluta o filename — extraer siempre el último segmento
			const filename = sizePath.split("/").pop()!;
			const fullPath = path.join(OUTPUT_DIR, filename);
			try {
				await fs.access(fullPath);
			} catch {
				errors.push(`  ✗  ${photo.id} → ${sizePath} (archivo no encontrado)`);
			}
		}
	}

	// 3. BlurHash nulo
	const noBlur = album.photos.filter((p) => !p.blurHash);
	if (noBlur.length > 0) {
		warnings.push(`  ⚠  Sin blurHash: ${noBlur.map((p) => p.id).join(", ")}`);
	}

	// 4. takenAt ausente
	const noDates = album.photos.filter((p) => !p.meta?.takenAt);
	if (noDates.length > 0) {
		warnings.push(`  ⚠  Sin takenAt (sin EXIF): ${noDates.map((p) => p.id).join(", ")}`);
	}

	// 5. Fotos sin GPS (informativo, no error)
	const noGps = album.photos.filter((p) => !p.meta?.gps);
	if (noGps.length > 0) {
		warnings.push(`  ℹ  Sin GPS: ${noGps.map((p) => p.id).join(", ")}`);
	}

	// Resumen
	if (warnings.length > 0) {
		console.warn("⚠️   Advertencias:\n");
		warnings.forEach((w) => console.warn(w));
		console.log();
	}

	if (errors.length === 0) {
		console.log(`✅  Todo correcto — ${checkedPaths.size} archivos verificados`);
		if (warnings.length === 0) console.log(`🚀  Listo para subir a R2`);
	} else {
		console.error(`\n❌  ${errors.length} error(es):\n`);
		errors.forEach((e) => console.error(e));
		process.exit(1);
	}
};

main();
