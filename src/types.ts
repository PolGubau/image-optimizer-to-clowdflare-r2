/**
 * types.ts
 *
 * Tipos compartidos entre el script de proceso y las webs que consumen el JSON.
 * Copia este archivo a tu proyecto web o publícalo como paquete.
 */

export type SizeSuffix = "thumb" | "medium" | "large";

export type Gps = { lat: number; lng: number; alt?: number };
export type Camera = { make: string; model: string };
export type Exposure = { aperture: number; shutter: string; iso: number };

export type PhotoMeta = {
	takenAt: string | null;
	gps: Gps | null;
	camera: Camera | null;
	lens: string | null;
	exposure: Exposure | null;
};

export type Orientation = "portrait" | "landscape" | "square";

/** Color dominante de la foto para usar como fondo de placeholder o card. */
export type Palette = {
	bg: string; // hex — color dominante (p.e. "#a87c5b")
	fg: string; // "#000000" o "#ffffff" — color de texto legible encima
};

/** Navegación entre fotos del álbum. */
export type PhotoNav = {
	prev: string | null; // id de la foto anterior
	next: string | null; // id de la foto siguiente
};

export type Photo = {
	id: string;             // granada-001
	filename: string;       // IMG_20260404_095723
	label: string | null;
	isCover: boolean;
	orientation: Orientation;
	blurHash: string | null;
	palette: Palette;
	srcset: string;         // listo para usar en <img srcset="...">
	nav: PhotoNav;
	width: number;
	height: number;
	aspectRatio: number;
	sizes: Record<SizeSuffix, string>;
	meta: PhotoMeta;
};

export type Album = {
	id: string;
	title: string;
	count: number;
	duration: string | null; // "1 día", "3 días"
	cover: string;           // photo id
	photos: Photo[];
};

export type AlbumSummary = {
	id: string;
	title: string;
	count: number;
	duration: string | null;
	cover: string;
	coverThumb: string;
	dateFrom: string | null;
	dateTo: string | null;
	updatedAt: string;
};
