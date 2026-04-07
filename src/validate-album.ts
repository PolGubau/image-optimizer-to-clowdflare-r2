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

const ALBUM = process.argv[2] ?? "granada";
const OUTPUT_DIR = `./output/${ALBUM}`;

type SizeSuffix = "thumb" | "medium" | "large";
type Photo = {
	id: string;
	filename: string;
	sizes: Record<SizeSuffix, string>;
};
type Album = { id: string; count: number; photos: Photo[] };

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

	for (const photo of album.photos) {
		for (const sizePath of Object.values(photo.sizes)) {
			const fullPath = path.join(OUTPUT_DIR, path.basename(sizePath));
			try {
				await fs.access(fullPath);
			} catch {
				errors.push(`  ✗  ${photo.id} → ${sizePath}`);
			}
		}
	}

	if (errors.length === 0) {
		console.log(`✅  Todo correcto — ${album.count * 3} archivos verificados`);
		console.log(`🚀  Listo para subir a R2`);
	} else {
		console.error(`❌  Faltan ${errors.length} archivo(s):\n`);
		errors.forEach((e) => console.error(e));
		process.exit(1);
	}
};

main();
