/**
 * process-album.ts
 *
 * Optimiza un álbum de fotos para servir en web:
 *   - 3 tamaños AVIF (thumb / medium / large) — 20-30% más pequeño que WebP
 *   - Tamaños redundantes omitidos si el original es más pequeño
 *   - BlurHash para placeholders mientras cargan las imágenes
 *   - Metadata extraída (GPS, fecha, cámara, exposición)

 *   - Labels opcionales vía input/<album>/labels.json
 *   - IDs limpios y cronológicos: granada-001, granada-002…
 *   - EXIF eliminado de las imágenes de salida (privacidad)
 *   - Procesado incremental (salta archivos ya generados)
 *   - JSON con rutas relativas (tú pones el base URL en tu web)
 *
 * Uso:
 *   tsx src/process-album.ts <album>
 *   tsx src/process-album.ts granada
 *
 * Labels opcionales → input/<album>/labels.json:
 *   { "IMG_20260404_095723": "Alhambra al amanecer" }
 *
 * Portada → input/<album>/cover.txt:
 *   IMG_20260404_142332   (filename sin extensión)
 */

import path from "path";
import exifr from "exifr";
import fs from "fs/promises";
import { glob } from "glob";
import { encode as blurhashEncode } from "blurhash";
import pLimit from "p-limit";
import sharp from "sharp";

// ── Config ────────────────────────────────────────────────────────────────────

const ALBUM = process.argv[2] ?? "granada";
const FORCE_FILE = process.argv[3] ?? null; // fuerza reprocesar un archivo concreto
const INPUT_DIR = `./input/${ALBUM}`;
const OUTPUT_DIR = `./output/${ALBUM}`;
const CONCURRENCY = 4;

const SIZES = [
	{ suffix: "thumb",  width: 400,  quality: 65 }, // grids / thumbnails
	{ suffix: "medium", width: 900,  quality: 70 }, // mobile / lightbox preview
	{ suffix: "large",  width: 1800, quality: 75 }, // desktop full-view
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

import type {
	SizeSuffix,
	Gps,
	Camera,
	Exposure,
	PhotoMeta,
	Orientation,
	Palette,
	Photo,
	Album,
	AlbumSummary,
} from "./types.js";

/** Photo sin campos finales — se asignan en main tras ordenar */
type PhotoDraft = Omit<Photo, "id" | "nav">;

// ── Helpers ───────────────────────────────────────────────────────────────────

const exists = (p: string) =>
	fs
		.access(p)
		.then(() => true)
		.catch(() => false);

const bytesToKB = (n: number) => (n / 1024).toFixed(1);

/** Formatea una fecha usando getters locales — preserva la hora del móvil sin asumir UTC. */
const formatLocalDate = (d: Date): string => {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Omite campos null/undefined del JSON — menos bytes, menos ruido. */
const toJSON = (value: unknown) =>
	JSON.stringify(value, (_k, v) => (v === null || v === undefined ? undefined : v), 2);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Geocoding (Nominatim / OpenStreetMap) ─────────────────────────────────────

type NominatimAddress = {
	tourism?: string;
	historic?: string;
	leisure?: string;
	amenity?: string;
	neighbourhood?: string;
	quarter?: string;
	suburb?: string;
	city_district?: string;
	city?: string;
	town?: string;
	village?: string;
};

/**
 * Convierte coordenadas GPS en un nombre de lugar legible.
 * Usa Nominatim (OpenStreetMap) — gratuito, sin API key.
 * Rate limit: máx 1 req/seg (se gestiona desde main).
 */
const reverseGeocode = async (
	lat: number,
	lng: number,
): Promise<string | null> => {
	try {
		const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=es`;
		const res = await fetch(url, {
			headers: { "User-Agent": "image-optimize-script/1.0" },
		});
		if (!res.ok) return null;

		const data = (await res.json()) as { address?: NominatimAddress };
		const a = data.address;
		if (!a) return null;

		// Nombre más específico disponible (POI > barrio > ciudad)
		const place =
			a.tourism ??
			a.historic ??
			a.leisure ??
			a.amenity ??
			a.neighbourhood ??
			a.quarter ??
			a.suburb ??
			a.city_district;

		const city = a.city ?? a.town ?? a.village;

		if (place && city && place !== city) return `${place}, ${city}`;
		if (place) return place;
		if (city) return city;
		return null;
	} catch {
		return null;
	}
};

/** Formatea ExposureTime (segundos) como fracción legible: 0.001 → "1/1000" */
const formatShutter = (seconds: number): string => {
	if (seconds >= 1) return `${seconds}s`;
	const denom = Math.round(1 / seconds);
	return `1/${denom}`;
};


const toOrientation = (w: number, h: number): Orientation => {
	if (Math.abs(w - h) < 10) return "square";
	return w > h ? "landscape" : "portrait";
};

/** Genera un BlurHash de 4×3 componentes desde un thumbnail 32px. */
const getBlurHash = async (file: string): Promise<string | null> => {
	try {
		const { data, info } = await sharp(file)
			.resize(32, 32, { fit: "inside" })
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		return blurhashEncode(
			new Uint8ClampedArray(data),
			info.width,
			info.height,
			4,
			3,
		);
	} catch {
		return null;
	}
};

/**
 * Lee input/<album>/labels.json si existe.
 * Formato: { "IMG_20260404_095723": "Alhambra al amanecer" }
 */
const readLabels = async (album: string): Promise<Record<string, string>> => {
	try {
		const raw = await fs.readFile(`./input/${album}/labels.json`, "utf8");
		return JSON.parse(raw) as Record<string, string>;
	} catch {
		return {};
	}
};

// Cache de geocoding: output/<album>/geo-cache.json (artefacto generado, no fuente)
// Formato: { "37.175053,-3.599189": "Sagrario, Granada" }
const geoCachePath = (album: string) => `./output/${album}/geo-cache.json`;

const readGeoCache = async (album: string): Promise<Record<string, string>> => {
	try {
		const raw = await fs.readFile(geoCachePath(album), "utf8");
		return JSON.parse(raw) as Record<string, string>;
	} catch {
		return {};
	}
};

const saveGeoCache = async (
	album: string,
	cache: Record<string, string>,
): Promise<void> => {
	await fs.writeFile(geoCachePath(album), JSON.stringify(cache, null, 2));
};

const geoKey = (lat: number, lng: number) => `${lat},${lng}`;

/**
 * Lee input/<album>/cover.txt si existe.
 * Contenido: el filename sin extensión de la foto portada.
 * Ejemplo: IMG_20260404_142332
 */
const readCover = async (album: string): Promise<string | null> => {
	try {
		const raw = await fs.readFile(`./input/${album}/cover.txt`, "utf8");
		return raw.trim();
	} catch {
		return null;
	}
};

/** Color dominante de la foto para fondos y texto accesible. */
const getPalette = async (file: string): Promise<Palette> => {
	try {
		const { data } = await sharp(file)
			.resize(1, 1)
			.removeAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		const [r, g, b] = [data[0], data[1], data[2]];
		const hex = (n: number) => n.toString(16).padStart(2, "0");
		const bg = `#${hex(r)}${hex(g)}${hex(b)}`;
		return { bg };
	} catch {
		return { bg: "#888888" };
	}
};


/** Duración del álbum en lenguaje natural (días calendario, no horas). */
const albumDuration = (from: string | null, to: string | null): string | null => {
	if (!from || !to) return null;
	const fromDay = from.split("T")[0];
	const toDay = to.split("T")[0];
	if (fromDay === toDay) return "1 día";
	const days = Math.round(
		(new Date(toDay).getTime() - new Date(fromDay).getTime()) / 86_400_000,
	) + 1;
	return `${days} días`;
};

/** Extrae metadata útil del archivo desde el EXIF nativo. */
const extractMeta = async (file: string): Promise<PhotoMeta> => {
	const [exif, gpsDecimal] = await Promise.all([
		exifr
			.parse(file, {
				pick: [
					"DateTimeOriginal",
					"CreateDate",
					"GPSAltitude",
					"Make",
					"Model",
					"LensModel",
					"FNumber",
					"ExposureTime",
					"ISO",
				],
			})
			.catch(() => null) as Promise<Record<string, unknown> | null>,
		exifr.gps(file).catch(() => null) as Promise<{
			latitude: number;
			longitude: number;
		} | null>,
	]);

	// Fecha ───────────────────────────────────────────────────────────────────
	// EXIF no guarda timezone → formateamos con getters locales (hora del móvil)
	// sin sufijo Z para no implicar UTC. Ej: "2026-04-04T07:57:23"
	const exifDate = exif?.DateTimeOriginal ?? exif?.CreateDate;
	const takenAt = exifDate instanceof Date ? formatLocalDate(exifDate) : null;

	// GPS — exifr.gps() ya devuelve decimales ─────────────────────────────────
	let gps: Gps | undefined;
	if (gpsDecimal && (gpsDecimal.latitude !== 0 || gpsDecimal.longitude !== 0)) {
		const rawAlt = exif?.GPSAltitude as number | undefined;
		gps = {
			lat: Number(gpsDecimal.latitude.toFixed(6)),
			lng: Number(gpsDecimal.longitude.toFixed(6)),
			...(rawAlt !== undefined && rawAlt !== 0
				? { alt: Number(rawAlt.toFixed(1)) }
				: {}),
		};
	}

	// Cámara ──────────────────────────────────────────────────────────────────
	const make = (exif?.Make as string | undefined)?.trim();
	const model = (exif?.Model as string | undefined)?.trim();
	const camera: Camera | undefined = make && model ? { make, model } : undefined;

	// Lente ───────────────────────────────────────────────────────────────────
	const lens = (exif?.LensModel as string | undefined)?.trim() || undefined;

	// Exposición ──────────────────────────────────────────────────────────────
	const aperture = exif?.FNumber as number | undefined;
	const exposureTime = exif?.ExposureTime as number | undefined;
	const iso = exif?.ISO as number | undefined;
	const exposure: Exposure | undefined =
		aperture !== undefined && exposureTime !== undefined && iso !== undefined
			? { aperture, shutter: formatShutter(exposureTime), iso }
			: undefined;

	return { takenAt, gps, camera, lens, exposure };
};

// ── Index ─────────────────────────────────────────────────────────────────────

/** Actualiza output/index.json con el resumen del álbum procesado. */
const updateIndex = async (summary: AlbumSummary): Promise<void> => {
	const indexPath = "./output/index.json";
	let entries: AlbumSummary[] = [];
	try {
		const raw = await fs.readFile(indexPath, "utf8");
		entries = JSON.parse(raw) as AlbumSummary[];
	} catch { /* primera vez */ }

	const i = entries.findIndex((e) => e.id === summary.id);
	if (i >= 0) entries[i] = summary;
	else entries.push(summary);

	entries.sort((a, b) => a.id.localeCompare(b.id));
	await fs.writeFile(indexPath, toJSON(entries));
};

// ── Core ──────────────────────────────────────────────────────────────────────

const processImage = async (
	file: string,
	stats: { saved: number; skipped: number },
): Promise<PhotoDraft | null> => {
	const filename = path.basename(file, path.extname(file));
	const originalStat = await fs.stat(file);

	// Dimensiones originales primero — para saltar tamaños redundantes
	const sharpMeta = await sharp(file).metadata();
	const w = sharpMeta.width ?? 0;
	const h = sharpMeta.height ?? 0;
	const originalWidth = w;

	let outputBytes = 0;
	const sizes = {} as Record<SizeSuffix, string>;
	let lastSuffix: SizeSuffix = "thumb";

	for (const { suffix, width, quality } of SIZES) {
		// Original más pequeño que el target → reutilizar el tamaño anterior
		if (originalWidth < width) {
			sizes[suffix] = sizes[lastSuffix];
			continue;
		}

		const outPath = path.join(OUTPUT_DIR, `${filename}_${suffix}.avif`);
		sizes[suffix] = `${filename}_${suffix}.avif`;
		lastSuffix = suffix;

		const isForced = FORCE_FILE === filename;
		if (!isForced && await exists(outPath)) {
			const s = await fs.stat(outPath);
			outputBytes += s.size;
			stats.skipped++;
			continue;
		}

		const info = await sharp(file)
			.rotate()
			.resize({ width, withoutEnlargement: true })
			.avif({ quality, effort: 5 })
			.toFile(outPath);

		outputBytes += info.size;
	}

	const [photoMeta, blurHash, palette] = await Promise.all([
		extractMeta(file),
		getBlurHash(file),
		getPalette(file),
	]);

	stats.saved += originalStat.size - outputBytes;

	return {
		filename,
		label: undefined,
		orientation: toOrientation(w, h),
		blurHash,
		palette,
		width: w,
		height: h,
		sizes,
		meta: photoMeta,
	};
};

// ── Main ──────────────────────────────────────────────────────────────────────

const main = async () => {
	console.log(`📂  Álbum: ${ALBUM}`);
	console.log(`📥  Input:  ${INPUT_DIR}`);
	console.log(`📤  Output: ${OUTPUT_DIR}\n`);

	await fs.mkdir(OUTPUT_DIR, { recursive: true });

	const [files, labels, geoCache, coverFilename] = await Promise.all([
		glob(`${INPUT_DIR}/**/*.{jpg,jpeg,png,JPG,JPEG,PNG}`),
		readLabels(ALBUM),
		readGeoCache(ALBUM),
		readCover(ALBUM),
	]);

	if (files.length === 0) {
		console.error(`❌  No se encontraron imágenes en ${INPUT_DIR}`);
		process.exit(1);
	}

	console.log(`🖼️   ${files.length} imágenes encontradas`);
	if (Object.keys(labels).length > 0)
		console.log(`🏷️   ${Object.keys(labels).length} labels cargados`);
	if (FORCE_FILE)
		console.log(`🔁  Forzando reprocesado de: ${FORCE_FILE}`);
	console.log();

	const limit = pLimit(CONCURRENCY);
	const stats = { saved: 0, skipped: 0 };
	const drafts: PhotoDraft[] = [];
	let processed = 0;

	await Promise.all(
		files.map((file) =>
			limit(async () => {
				const draft = await processImage(file, stats).catch((err) => {
					console.warn(`⚠️  Error procesando ${file}: ${err.message}`);
					return null;
				});
				if (draft) drafts.push(draft);
				processed++;
				process.stdout.write(`\r   ${processed}/${files.length} procesadas...`);
			}),
		),
	);

	console.log("\n");

	// Orden cronológico; sin fecha al final, orden alfabético entre ellas
	drafts.sort((a, b) => {
		const ta = a.meta.takenAt ?? "9999";
		const tb = b.meta.takenAt ?? "9999";
		return ta < tb ? -1 : ta > tb ? 1 : a.filename.localeCompare(b.filename);
	});

	// Auto-geocoding — solo fotos sin label manual y cuya coordenada no esté cacheada
	const needsGeo = drafts.filter((d) => {
		if (labels[d.filename] || !d.meta.gps) return false;
		return !geoCache[geoKey(d.meta.gps.lat, d.meta.gps.lng)];
	});

	if (needsGeo.length > 0) {
		console.log(`🌍  Geocodificando ${needsGeo.length} fotos nuevas...`);
		for (const draft of needsGeo) {
			const key = geoKey(draft.meta.gps!.lat, draft.meta.gps!.lng);
			const place = await reverseGeocode(
				draft.meta.gps!.lat,
				draft.meta.gps!.lng,
			);
			if (place) geoCache[key] = place;
			await sleep(1100); // respeta el rate limit de Nominatim
		}
		await saveGeoCache(ALBUM, geoCache);
		console.log("   ✓ Cache actualizado\n");
	}

	// Asignar id, label — manual > cache GPS > null
	const photos: Photo[] = drafts.map((draft, i) => {
		const gps = draft.meta.gps;
		const autoLabel = gps ? (geoCache[geoKey(gps.lat, gps.lng)] ?? null) : null;
		return {
			id: `${ALBUM}-${String(i + 1).padStart(3, "0")}`,
			filename: draft.filename,
			label: labels[draft.filename] ?? autoLabel,
			orientation: draft.orientation,
			blurHash: draft.blurHash,
			palette: draft.palette,
			nav: {}, // se rellena abajo
			width: draft.width,
			height: draft.height,
			sizes: draft.sizes,
			meta: draft.meta,
		};
	});

	// Nav prev/next (undefined = primer/último — se omite en el JSON)
	photos.forEach((photo, i) => {
		photo.nav.prev = i > 0 ? photos[i - 1].id : undefined;
		photo.nav.next = i < photos.length - 1 ? photos[i + 1].id : undefined;
	});

	const cover = photos.find((p) => p.filename === coverFilename) ?? photos[0];

	const dates = photos
		.map((p) => p.meta.takenAt)
		.filter((d): d is string => d !== null)
		.sort();

	const album: Album = {
		id: ALBUM,
		title: ALBUM.charAt(0).toUpperCase() + ALBUM.slice(1),
		count: photos.length,
		duration: albumDuration(dates[0] ?? null, dates[dates.length - 1] ?? null),
		cover: cover.id,
		coverBlurHash: cover.blurHash,
		photos,
	};

	const jsonPath = path.join(OUTPUT_DIR, "album.json");
	await fs.writeFile(jsonPath, toJSON(album));

	await updateIndex({
		id: ALBUM,
		title: album.title,
		cover: cover.id,
		coverThumb: cover.sizes.thumb,
		coverBlurHash: cover.blurHash,
	});

	console.log(`✅  album.json generado → ${jsonPath}`);
	console.log(`🗂️  output/index.json actualizado`);
	console.log(`📦  Espacio ahorrado:  ~${bytesToKB(stats.saved)} KB`);
	console.log(`⏭️   Archivos saltados: ${stats.skipped} (ya existían)`);
};

main();
