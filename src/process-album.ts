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
 *   - URLs absolutas en el JSON si se configura input/config.json
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

import os from "os";
import path from "path";
import exifr from "exifr";
import fs from "fs/promises";
import { glob } from "glob";
import { encode as blurhashEncode } from "blurhash";
import pLimit from "p-limit";
import sharp from "sharp";
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

// ── Config ────────────────────────────────────────────────────────────────────

// Separar flags (--xxx) de args posicionales para evitar que --json-only
// acabe asignado a FORCE_FILE si el orden de args cambia.
const _positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const _flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));

const ALBUM      = _positional[0] ?? "granada";
const FORCE_FILE = _positional[1] ?? null; // fuerza reprocesar un archivo concreto
const JSON_ONLY  = _flags.has("--json-only"); // solo regenera el JSON, no toca imágenes
const INPUT_DIR = `./input/${ALBUM}`;
const OUTPUT_DIR = `./output/${ALBUM}`;
// Usar todos los cores menos uno para no bloquear el sistema durante el proceso
const CONCURRENCY = Math.max(1, os.cpus().length - 1);

const SIZES = [
	{ suffix: "thumb",  width: 400,  quality: 55, effort: 2 }, // thumbnails — mínimo esfuerzo, se ven en grid
	{ suffix: "medium", width: 900,  quality: 70, effort: 3 }, // mobile / lightbox preview
	{ suffix: "large",  width: 1800, quality: 80, effort: 4 }, // desktop — calidad visible, effort razonable
] as const;

/** Photo sin campos finales — se asignan en main tras ordenar */
type PhotoDraft = Omit<Photo, "id" | "nav">;

// ── Helpers ───────────────────────────────────────────────────────────────────

const exists = (p: string) =>
	fs
		.access(p)
		.then(() => true)
		.catch(() => false);

const bytesToKB = (n: number) => (n / 1024).toFixed(1);

/** Formatea milisegundos como "4m 32s" o "45s". */
const formatDuration = (ms: number): string => {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** Formatea segundos restantes como ETA legible. */
const formatETA = (seconds: number): string => {
	if (!isFinite(seconds) || seconds <= 0) return "...";
	const s = Math.round(seconds);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
};

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


// Umbral de 10px: diferencia mínima para no clasificar como "square"
// fotos que son casi cuadradas por rotación o crop.
const SQUARE_THRESHOLD = 10;
const toOrientation = (w: number, h: number): Orientation => {
	if (Math.abs(w - h) < SQUARE_THRESHOLD) return "square";
	return w > h ? "landscape" : "portrait";
};

/** Genera un BlurHash de 4×3 componentes desde un thumbnail 32px. */
const getBlurHash = async (input: Buffer | string): Promise<string | null> => {
	try {
		const { data, info } = await sharp(input)
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

// ── Config global ──────────────────────────────────────────────────────────────

const readConfig = async (): Promise<{ cdnBase: string }> => {
	try {
		const raw = await fs.readFile("./input/config.json", "utf8");
		return JSON.parse(raw) as { cdnBase: string };
	} catch {
		return { cdnBase: "" };
	}
};

/**
 * Añade el cdnBase a los filenames de sizes para que el JSON tenga URLs absolutas.
 * Si cdnBase está vacío devuelve los filenames sin modificar (desarrollo local).
 */
const applyCdn = (
	sizes: Record<SizeSuffix, string>,
	cdnBase: string,
	album: string,
): Record<SizeSuffix, string> => {
	if (!cdnBase) return sizes;
	return Object.fromEntries(
		Object.entries(sizes).map(([k, v]) => [k, `${cdnBase}/${album}/${v}`]),
	) as Record<SizeSuffix, string>;
};

/**
 * Elimina el prefijo cdnBase de una URL para recuperar el filename original.
 * Necesario en --json-only para re-aplicar un cdnBase distinto.
 */
const stripCdn = (url: string, cdnBase: string, album: string): string => {
	const prefix = `${cdnBase}/${album}/`;
	return cdnBase && url.startsWith(prefix) ? url.slice(prefix.length) : url;
};

const readGeoCache = async (album: string): Promise<Record<string, string>> => {
	try {
		const raw = await fs.readFile(geoCachePath(album), "utf8");
		const cache = JSON.parse(raw) as Record<string, string>;
		// Migrar claves de precisión total → 3 decimales (~110m grid)
		// Las entradas antiguas se consolidan automáticamente
		const migrated: Record<string, string> = {};
		for (const [key, value] of Object.entries(cache)) {
			const [lat, lng] = key.split(",").map(Number);
			if (!isNaN(lat) && !isNaN(lng)) {
				const rounded = geoKey(lat, lng);
				migrated[rounded] ??= value;
			}
		}
		return migrated;
	} catch {
		return {};
	}
};

const saveGeoCache = async (
	album: string,
	cache: Record<string, string>,
): Promise<void> => {
	await fs.writeFile(geoCachePath(album), toJSON(cache));
};

// 3 decimales = ~110m de precisión — suficiente para geocoding, reduce API calls
const geoKey = (lat: number, lng: number) => `${lat.toFixed(3)},${lng.toFixed(3)}`;

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
const getPalette = async (input: Buffer | string): Promise<Palette> => {
	try {
		const { data } = await sharp(input)
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
const albumDuration = (from: string | undefined, to: string | undefined): string | undefined => {
	if (!from || !to) return undefined;
	const fromDay = from.split("T")[0];
	const toDay = to.split("T")[0];
	if (fromDay === toDay) return "1 día";
	const days = Math.round(
		(new Date(toDay).getTime() - new Date(fromDay).getTime()) / 86_400_000,
	) + 1;
	return `${days} días`;
};

/** Extrae metadata útil del archivo desde el EXIF nativo.
 *  Recibe el buffer ya leído para evitar I/O adicional y para que
 *  exifr.gps() opere sobre datos en memoria (sin límite de firstChunkSize),
 *  lo que es necesario para HEIC donde el GPS IFD puede estar >40 KB adentro.
 */
const extractMeta = async (buffer: Buffer): Promise<PhotoMeta> => {
	const [exif, gpsDecimal] = await Promise.all([
		exifr
			.parse(buffer, {
				pick: [
					"DateTimeOriginal",
					"CreateDate",
					"OffsetTimeOriginal",
					"GPSAltitude",
					"Make",
					"Model",
					"LensModel",
					"FNumber",
					"ExposureTime",
					"ISO",
					"FocalLength",
					"Flash",
					"ExposureMode",
				],
			})
			.catch(() => null) as Promise<Record<string, unknown> | null>,
		exifr.gps(buffer).catch(() => null) as Promise<{
			latitude: number;
			longitude: number;
		} | null>,
	]);

	// Fecha ───────────────────────────────────────────────────────────────────
	// Si el EXIF incluye OffsetTimeOriginal (ej. "+02:00") usamos ISO 8601 completo.
	// Si no, guardamos hora local sin sufijo para no implicar UTC.
	const exifDate = exif?.DateTimeOriginal ?? exif?.CreateDate;
	const tzOffset = exif?.OffsetTimeOriginal as string | undefined;
	const takenAt = exifDate instanceof Date
		? tzOffset
			? `${formatLocalDate(exifDate)}${tzOffset}`   // "2026-04-04T09:57:23+02:00"
			: formatLocalDate(exifDate)                    // "2026-04-04T09:57:23"
		: undefined;

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
	const focalLength = exif?.FocalLength as number | undefined;
	// Flash: exifr devuelve una cadena tipo "Flash did not fire..." — parseamos si disparó
	const flashRaw = exif?.Flash as string | undefined;
	const flash = flashRaw !== undefined
		? /fired|yes/i.test(flashRaw)
		: undefined;
	// ExposureMode: 0 = Auto, 1 = Manual, 2 = Auto bracket
	const exposureModeRaw = exif?.ExposureMode as number | string | undefined;
	const mode: import("./types.js").ExposureMode | undefined =
		exposureModeRaw === 1 || exposureModeRaw === "Manual" ? "manual"
		: exposureModeRaw === 0 || exposureModeRaw === "Auto" ? "auto"
		: undefined;

	const exposure: Exposure | undefined =
		aperture !== undefined && exposureTime !== undefined && iso !== undefined
			? {
				aperture,
				shutter: formatShutter(exposureTime),
				iso,
				...(focalLength !== undefined ? { focalLength: Number(focalLength.toFixed(2)) } : {}),
				...(flash !== undefined ? { flash } : {}),
				...(mode !== undefined ? { mode } : {}),
			}
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

type ImageResult = { draft: PhotoDraft; saved: number; skipped: boolean };

const processImage = async (
	file: string,
	existingPhotos: Map<string, Photo>,
	oldCdnBase: string,
): Promise<ImageResult> => {
	const filename = path.basename(file, path.extname(file));

	// Early exit: si el thumb ya existe y tenemos datos en caché,
	// reutilizamos todo sin leer el buffer ni recomputar EXIF/blurHash/palette
	const thumbPath = path.join(OUTPUT_DIR, `${filename}_thumb.avif`);
	const cached = existingPhotos.get(filename);
	if (FORCE_FILE !== filename && cached && await exists(thumbPath)) {
		const rawSizes = Object.fromEntries(
			Object.entries(cached.sizes).map(([k, v]) => [k, stripCdn(v, oldCdnBase, ALBUM)]),
		) as Record<SizeSuffix, string>;
		return {
			draft: {
				filename: cached.filename,
				orientation: cached.orientation,
				blurHash: cached.blurHash,
				palette: cached.palette,
				width: cached.width,
				height: cached.height,
				sizes: rawSizes,
				meta: cached.meta,
			},
			saved: 0,
			skipped: true,
		};
	}

	// Leer a buffer una sola vez — evita 5-6 lecturas de disco por imagen
	const inputBuffer = await fs.readFile(file);
	const originalSize = inputBuffer.length;

	// Dimensiones originales — para saltar tamaños redundantes
	const sharpMeta = await sharp(inputBuffer).metadata();
	const w = sharpMeta.width ?? 0;
	const h = sharpMeta.height ?? 0;

	let outputBytes = 0;
	let newSizesGenerated = 0;
	const sizes = {} as Record<SizeSuffix, string>;
	let lastSuffix: SizeSuffix = "thumb";

	for (const { suffix, width, quality, effort } of SIZES) {
		// Original más pequeño que el target → reutilizar el tamaño anterior
		if (w < width) {
			sizes[suffix] = sizes[lastSuffix];
			continue;
		}

		const outPath = path.join(OUTPUT_DIR, `${filename}_${suffix}.avif`);
		sizes[suffix] = `${filename}_${suffix}.avif`;
		lastSuffix = suffix;

		if (FORCE_FILE !== filename && await exists(outPath)) {
			outputBytes += (await fs.stat(outPath)).size;
			continue;
		}

		const info = await sharp(inputBuffer)
			.rotate()
			.resize({ width, withoutEnlargement: true })
			.avif({ quality, effort })
			.toFile(outPath);

		outputBytes += info.size;
		newSizesGenerated++;
	}

	const [photoMeta, blurHash, palette] = await Promise.all([
		extractMeta(inputBuffer),
		getBlurHash(inputBuffer),
		getPalette(inputBuffer),
	]);

	return {
		draft: {
			filename,
			orientation: toOrientation(w, h),
			blurHash: blurHash ?? undefined,
			palette,
			width: w,
			height: h,
			sizes,
			meta: photoMeta,
		},
		saved: originalSize - outputBytes,
		skipped: newSizesGenerated === 0,
	};
};

// ── Main ──────────────────────────────────────────────────────────────────────

/** Modo rápido: aplica labels.json y cover.txt sobre el album.json existente sin reencoder. */
const rebuildJsonOnly = async () => {
	const jsonPath = path.join(OUTPUT_DIR, "album.json");
	let existing: Album;
	try {
		existing = JSON.parse(await fs.readFile(jsonPath, "utf8")) as Album;
	} catch {
		console.error(`❌  No existe ${jsonPath} — ejecuta primero pnpm process:new ${ALBUM}`);
		process.exit(1);
	}

	// Leer config viejo ANTES de sobrescribirlo — necesario para hacer strip+reapply
	let oldConfig: { cdnBase: string } = { cdnBase: "" };
	try { oldConfig = JSON.parse(await fs.readFile("./output/config.json", "utf8")); } catch { /* primera vez */ }

	const [labels, geoCache, coverFilename, config] = await Promise.all([
		readLabels(ALBUM),
		readGeoCache(ALBUM),
		readCover(ALBUM),
		readConfig(),
	]);

	await fs.writeFile("./output/config.json", toJSON(config));

	const photos: Photo[] = existing.photos.map((photo) => {
		const gps = photo.meta.gps;
		const autoLabel = gps ? geoCache[geoKey(gps.lat, gps.lng)] : undefined;
		// Strip cdnBase viejo → aplica el nuevo (soporta cambio de dominio sin reencoder)
		const rawSizes = Object.fromEntries(
			Object.entries(photo.sizes).map(([k, v]) => [k, stripCdn(v, oldConfig.cdnBase, ALBUM)]),
		) as Record<SizeSuffix, string>;
		return {
			...photo,
			sizes: applyCdn(rawSizes, config.cdnBase, ALBUM),
			label: labels[photo.filename] ?? autoLabel ?? photo.label,
			nav: {}, // se rellena abajo
		};
	});

	photos.forEach((photo, i) => {
		photo.nav.prev = i > 0 ? photos[i - 1].id : undefined;
		photo.nav.next = i < photos.length - 1 ? photos[i + 1].id : undefined;
	});

	const cover = photos.find((p) => p.filename === coverFilename) ?? photos[0];

	const album: Album = { ...existing, photos, cover: cover.id, coverBlurHash: cover.blurHash };
	await fs.writeFile(jsonPath, toJSON(album));

	await updateIndex({
		id: ALBUM,
		title: album.title,
		count: album.count,
		duration: album.duration,
		cover: cover.id,
		coverThumb: cover.sizes.thumb,
		coverBlurHash: cover.blurHash,
	});

	console.log(`✅  album.json actualizado (solo JSON) → ${jsonPath}`);
	console.log(`🗂️  output/index.json actualizado`);
};

const main = async () => {
	console.log(`📂  Álbum: ${ALBUM}`);
	console.log(`📥  Input:  ${INPUT_DIR}`);
	console.log(`📤  Output: ${OUTPUT_DIR}\n`);

	if (JSON_ONLY) return rebuildJsonOnly();

	await fs.mkdir(OUTPUT_DIR, { recursive: true });

	const [files, labels, geoCache, coverFilename, config] = await Promise.all([
		glob(`${INPUT_DIR}/**/*.{jpg,jpeg,png,heic,heif,JPG,JPEG,PNG,HEIC,HEIF}`),
		readLabels(ALBUM),
		readGeoCache(ALBUM),
		readCover(ALBUM),
		readConfig(),
	]);

	// Leer config y album.json existentes ANTES de sobrescribirlos
	// — necesario para early exit y strip+reapply de CDN
	let oldCdnBase = "";
	let existingPhotos = new Map<string, Photo>();
	try {
		const [oldConfigRaw, oldAlbumRaw] = await Promise.allSettled([
			fs.readFile("./output/config.json", "utf8"),
			fs.readFile(path.join(OUTPUT_DIR, "album.json"), "utf8"),
		]);
		if (oldConfigRaw.status === "fulfilled")
			oldCdnBase = (JSON.parse(oldConfigRaw.value) as { cdnBase: string }).cdnBase;
		if (oldAlbumRaw.status === "fulfilled") {
			const oldAlbum = JSON.parse(oldAlbumRaw.value) as Album;
			existingPhotos = new Map(oldAlbum.photos.map((p) => [p.filename, p]));
		}
	} catch { /* primera pasada, no hay datos previos */ }

	await fs.writeFile("./output/config.json", toJSON(config));

	if (files.length === 0) {
		console.error(`❌  No se encontraron imágenes en ${INPUT_DIR}`);
		process.exit(1);
	}

	// Detectar nombres duplicados (mismo basename, distinta extensión)
	// — generarían AVIFs idénticos y se sobreescribirían sin aviso
	const seen = new Set<string>();
	const dupes = new Set<string>();
	for (const f of files) {
		const base = path.basename(f, path.extname(f));
		if (seen.has(base)) dupes.add(base);
		else seen.add(base);
	}
	if (dupes.size > 0) {
		console.error(`❌  Nombres de archivo duplicados (causarían AVIFs idénticos):`);
		for (const d of dupes) console.error(`   • ${d}`);
		process.exit(1);
	}

	console.log(`🖼️   ${files.length} imágenes encontradas`);
	if (Object.keys(labels).length > 0)
		console.log(`🏷️   ${Object.keys(labels).length} labels cargados`);
	if (FORCE_FILE)
		console.log(`🔁  Forzando reprocesado de: ${FORCE_FILE}`);
	console.log();

	const limit = pLimit(CONCURRENCY);
	const failed: string[] = [];
	let processed = 0;
	const startTime = Date.now();

	const results = (await Promise.all(
		files.map((file) =>
			limit(async () => {
				const result = await processImage(file, existingPhotos, oldCdnBase).catch((err: Error) => {
					const name = path.basename(file);
					process.stdout.write("\n");
					console.warn(`⚠️  Error procesando ${name}: ${err.message}`);
					failed.push(name);
					return null;
				});
				processed++;
				const elapsed = (Date.now() - startTime) / 1000;
				const speed = processed / elapsed;
				const eta = processed < files.length
					? ` | ${speed.toFixed(1)} foto/s | ETA ~${formatETA((files.length - processed) / speed)}`
					: "";
				process.stdout.write(`\r   ${processed}/${files.length} procesadas...${eta}`);
				return result;
			}),
		),
	)).filter((r): r is ImageResult => r !== null);

	const drafts = results.map((r) => r.draft);
	const totalSaved  = results.reduce((sum, r) => sum + r.saved, 0);
	const totalSkipped = results.filter((r) => r.skipped).length;

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
		const autoLabel = gps ? geoCache[geoKey(gps.lat, gps.lng)] : undefined;
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
			sizes: applyCdn(draft.sizes, config.cdnBase, ALBUM),
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
		.filter((d): d is string => d !== undefined)
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
		count: album.count,
		duration: album.duration,
		cover: cover.id,
		coverThumb: cover.sizes.thumb,
		coverBlurHash: cover.blurHash,
	});

	const totalTime = formatDuration(Date.now() - startTime);

	console.log(`✅  album.json generado → ${jsonPath}`);
	console.log(`🗂️  output/index.json actualizado`);
	console.log(`📦  Espacio ahorrado:  ~${bytesToKB(totalSaved)} KB`);
	console.log(`⏭️   Fotos saltadas: ${totalSkipped} (ya procesadas)`);
	console.log(`⏱️   Tiempo total: ${totalTime}`);

	if (failed.length > 0) {
		console.warn(`\n❌  ${failed.length} foto(s) fallaron:`);
		for (const f of failed) console.warn(`   • ${f}`);
	}
};

main().catch((err: Error) => { console.error(`❌  ${err.message}`); process.exit(1); });
