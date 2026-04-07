/**
 * types.ts
 *
 * Tipos y helpers compartidos entre el script de proceso y las webs consumidoras.
 * Copia este archivo a tu proyecto web — no necesitas ninguna dependencia extra.
 */

export type SizeSuffix = "thumb" | "medium" | "large";

export type Gps = { lat: number; lng: number; alt?: number };
export type Camera = { make: string; model: string };
export type Exposure = { aperture: number; shutter: string; iso: number };

export type PhotoMeta = {
	takenAt: string | null;
	gps?: Gps;
	camera?: Camera;
	lens?: string;
	exposure?: Exposure;
};

export type Orientation = "portrait" | "landscape" | "square";

/** Solo el color dominante — el color de texto se deriva con getTextColor(). */
export type Palette = {
	bg: string; // hex — color dominante (p.e. "#a87c5b")
};

/** Navegación entre fotos del álbum. */
export type PhotoNav = {
	prev?: string; // id de la foto anterior
	next?: string; // id de la foto siguiente
};

export type Photo = {
	id: string;          // granada-001
	filename: string;    // IMG_20260404_095723
	label?: string;
	orientation: Orientation;
	blurHash: string | null;
	palette: Palette;
	nav: PhotoNav;
	width: number;
	height: number;
	sizes: Record<SizeSuffix, string>;
	meta: PhotoMeta;
};

export type Album = {
	id: string;
	title: string;
	count: number;
	duration: string | null;
	cover: string;
	coverBlurHash: string | null;
	photos: Photo[];
};

/** Entrada mínima del índice global — solo lo necesario para la home. */
export type AlbumSummary = {
	id: string;
	title: string;
	cover: string;
	coverThumb: string;
	coverBlurHash: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const SIZES: Record<SizeSuffix, number> = { thumb: 400, medium: 900, large: 1800 };

/** Genera el atributo srcset listo para <img srcset="...">. */
export const buildSrcset = (sizes: Record<SizeSuffix, string>): string => {
	const seen = new Set<string>();
	return (["thumb", "medium", "large"] as SizeSuffix[])
		.filter((s) => !seen.has(sizes[s]) && seen.add(sizes[s]))
		.map((s) => `${sizes[s]} ${SIZES[s]}w`)
		.join(", ");
};

/** Ratio de aspecto de la foto. */
export const getAspectRatio = (photo: Pick<Photo, "width" | "height">): number =>
	photo.height > 0 ? photo.width / photo.height : 0;

/** Color de texto accesible (#000 o #fff) sobre el color de fondo dado. */
export const getTextColor = (bg: string): "#000000" | "#ffffff" => {
	const r = parseInt(bg.slice(1, 3), 16);
	const g = parseInt(bg.slice(3, 5), 16);
	const b = parseInt(bg.slice(5, 7), 16);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? "#000000" : "#ffffff";
};
