# image-optimize-to-r2

CLI pipeline to process photo albums for web serving via Cloudflare R2 (or any static storage). Converts JPG/HEIC inputs to AVIF at multiple sizes, extracts EXIF metadata, generates BlurHash placeholders, auto-geocodes GPS coordinates, and produces a self-contained `album.json` ready to consume from any frontend.

## What it does

For each album in `input/<album>/`:
1. Encodes each photo to 3 AVIF sizes: `thumb` (400px/q55), `medium` (900px/q70), `large` (1800px/q80)
2. Extracts EXIF: date+timezone, GPS, camera, aperture, shutter, ISO, focal length, flash, exposure mode
3. Geocodes GPS → human-readable label via Nominatim (OpenStreetMap, rate-limited, cached)
4. Computes BlurHash (4×3) and dominant palette color for each photo
5. Sorts photos chronologically, assigns sequential IDs (`granada-001`, `granada-002`…)
6. Writes `output/<album>/album.json` and updates `output/index.json`

## Project structure

```
input/
  <album>/
    *.jpg / *.heic          # source photos
    labels.json             # optional: manual labels { "IMG_xxx": "Custom label" }
    cover.txt               # optional: filename (no ext) of the cover photo
output/
  index.json                # list of all albums (AlbumSummary[])
  <album>/
    album.json              # full album data (Album type)
    geo-cache.json          # geocoding cache (generated, keyed by "lat,lng")
    *_thumb.avif
    *_medium.avif
    *_large.avif
src/
  types.ts                  # shared types + helpers — copy to your frontend
  process-album.ts          # core: encode + metadata + geocoding
  process-all.ts            # batch: runs process:new for every album in input/
  export-labels.ts          # syncs auto-labels to input/<album>/labels.json
  validate-album.ts         # pre-upload validation
  storage-report.ts         # R2 usage vs 10 GB free tier
```

## Commands

| Command | Description |
|---|---|
| `pnpm process <album>` | Full reset + re-encode from scratch |
| `pnpm process:new <album>` | Incremental: skip existing AVIFs, regenerate JSON |
| `pnpm process:json <album> --json-only` | Instant: rewrite JSON only (labels/cover changes) |
| `pnpm process-albums` | Batch all albums in `input/` |
| `pnpm export-labels <album>` | Export auto-labels to `input/<album>/labels.json` for review |
| `pnpm validate <album>` | Check all referenced files exist before uploading |
| `pnpm storage` | Show disk usage per album vs R2 free tier |

## Typical workflow

```bash
# 1. First time
pnpm process granada

# 2. Review and fix geocoding labels
pnpm export-labels granada
# edit input/granada/labels.json
pnpm process:json granada --json-only   # instant — no re-encoding

# 3. Add new photos to input/granada/
pnpm process:new granada                # skips existing AVIFs

# 4. Before uploading
pnpm validate granada
```

## JSON output shape

```ts
// output/index.json — one entry per album
type AlbumSummary = {
  id: string;          // "granada"
  title: string;
  count: number;
  duration: string | null;   // "3 días"
  cover: string;             // photo id
  coverThumb: string;        // filename of thumb AVIF
  coverBlurHash: string | null;
}

// output/<album>/album.json
type Album = {
  id: string; title: string; count: number; duration: string | null;
  cover: string; coverBlurHash: string | null;
  photos: Photo[];
}

type Photo = {
  id: string;             // "granada-001"
  filename: string;       // "IMG_20260404_095723"
  label?: string;         // geocoded or manual
  orientation: "portrait" | "landscape" | "square";
  blurHash: string | null;
  palette: { bg: string };  // dominant hex color
  nav: { prev?: string; next?: string };
  width: number; height: number;
  sizes: { thumb: string; medium: string; large: string };
  meta: {
    takenAt: string | null;  // "2026-04-04T09:57:23+02:00" (ISO 8601 with tz if available)
    gps?: { lat: number; lng: number; alt?: number };
    camera?: { make: string; model: string };
    lens?: string;
    exposure?: { aperture: number; shutter: string; iso: number;
                 focalLength?: number; flash?: boolean; mode?: "auto" | "manual" };
  };
}
```

## Frontend integration

Copy `src/types.ts` to your project — no extra dependencies needed:

```ts
import { buildSrcset, getAspectRatio, getTextColor } from './types'

// srcset string ready for <img srcset="...">
buildSrcset(photo.sizes)

// aspect ratio for CSS aspect-ratio
getAspectRatio(photo)   // e.g. 0.45 for portrait

// accessible text color over palette background
getTextColor(photo.palette.bg)  // "#000000" | "#ffffff"
```

## Key implementation notes

- **No re-encoding if file exists**: `process:new` skips AVIFs already in `output/`
- **Geocoding cache**: keyed by `"lat,lng"`, stored in `output/<album>/geo-cache.json`; Nominatim rate limit enforced with 1.1s sleep per new coordinate
- **Null/undefined fields omitted**: JSON serialized with a custom replacer — missing EXIF fields don't appear in output
- **Timezone**: uses `OffsetTimeOriginal` EXIF field when available; falls back to local time string without `Z` suffix to avoid incorrect UTC assumption
- **HEIC support**: input glob includes `.heic`/`.HEIC` (requires libvips with HEIC support)
- **Concurrency**: 4 parallel Sharp workers via `p-limit`
